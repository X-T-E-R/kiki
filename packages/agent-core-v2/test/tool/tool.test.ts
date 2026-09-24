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
      return { id: alias } as Model;
    },
    getRequester: (alias: string) => ({
      model: { id: alias } as Model,
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
    expect(description).toContain('completion starts a follow-up turn when root is idle');
    expect(description).toContain('end the current turn normally');
    expect(description).toContain('no independent work remains');
    expect(description).toContain('TaskOutput or AgentList polling, sleep, or timed loops');
    expect(description).toContain('If you are a subagent, handle your own outstanding dependencies');
    expect(description).toContain('result must be returned synchronously in the same turn');
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

  it('renders the tool set for each subagent type', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL');
    expect(description).not.toContain('Tools: AgentRun, Bash');
  });

  it('limits AgentNotify guidance to parent-changing messages while notification is enabled', () => {
    ctx = createTestAgent();
    const description = agentDescription();
    expect(description).toContain('Subagents can use `AgentNotify`');
    expect(description).toContain('parent must change its actions before the final result arrives');
    expect(description).toContain('do not send startup confirmations, routine progress, completion notices, or final-result copies');
  });

  it('omits AgentNotify while parent notification is disabled', () => {
    ctx = createTestAgent(
      configServices(() => ({ providers: {}, agents: { notify_parent: false } })),
    );
    expect(agentDescription()).not.toContain('Subagents can use `AgentNotify`');
  });

  it.each(['AgentList', 'AgentSend'])('registers %s on the main profile', (toolName) => {
    ctx = createTestAgent();

    expect(ctx.toolsData().map((entry) => entry.name)).toContain(toolName);
  });

  it('renders global tool restrictions in subagent type descriptions', () => {
    ctx = createTestAgent(
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Bash'] },
      })),
    );

    const toolLines = agentDescription()
      .split('\n')
      .filter((line) => line.startsWith('  Tools:'));

    expect(toolLines.length).toBeGreaterThan(0);
    expect(toolLines.every((line) => !line.includes('Bash'))).toBe(true);
  });

  it('lists contributed tools the caller profile does not activate', () => {
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

    const description = agentDescription();
    const teammateTools = description.match(/- teammate: [^\n]*\n  Tools: ([^\n]*)/)?.[1];

    expect(teammateTools).toBeDefined();
    expect(teammateTools).toContain('AgentRun');
    expect(teammateTools).not.toContain('Write');
  });

  it('renders effective tools after applying disallowedTools', () => {
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

    expect(description).toContain('- restricted: Restricted agent\n  Allowed models: mock-model\n  Tools: Read');
    const toolsLine = description.match(/- allow-all-except: [^\n]*\n  Allowed models: mock-model\n  Tools: ([^\n]*)\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval\./)?.[1];
    expect(toolsLine).toBeDefined();
    const tools = toolsLine?.split(', ');
    expect(tools).toContain('Read');
    for (const name of [
      'Bash', 'BoardRead', 'BoardWrite', 'AskUserQuestion',
      'CronCreate', 'CronDelete', 'CronList', 'EnterPlanMode', 'ExitPlanMode',
      'CreateGoal', 'GetGoal', 'UpdateGoal', 'SetGoalBudget',
      'ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait',
    ]) {
      expect(tools).not.toContain(name);
    }
    expect(description).not.toContain('Tools: all');
    expect(description).not.toContain('Tools: Bash, Read, mcp__github__*');
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

  it('renders the available agent profiles section', () => {
    ctx = createTestAgent();

    expect(agentDescription()).toContain('Available agent profiles');
  });

  it('lists configured aliases and explains explicit caller inheritance without a silent fallback', () => {
    ctx = createTestAgent({ initialConfig: { models: POOL_MODEL_ENTRIES } });

    const description = agentDescription();

    expect(description).toContain('Model aliases available across the targets above');
    expect(description).toContain('provider/fast');
    expect(description).toContain('provider/smart');
    expect(description).toContain('Set model_alias to inherit explicitly');
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
      'model_alias to "inherit"',
    );
    expect((properties['effort'] as { description?: string }).description).toContain(
      'target default thinking effort',
    );
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
    lifecycle.addHandle('main', 'agent');
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
    expect(agentTool(context).description).toContain('Allowed models: mock-model, provider/fast');
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
    expect(result.output).toContain('do not inherit the caller\'s model unless model_alias is explicitly set to inherit');
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
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced             { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" } }
        [emit] context.spliced             { "time": "<time>", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [wire] turn.prompt                 { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" }, "time": "<time>" }
        [wire] plugin.session_start        { "content": null, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "hash": "1ae16b3fa45c92e2d432e1170869be7a2edee1db12099adbf76e9e0993061902", "tools": [ { "name": "AgentList", "description": "List the subagents this agent started, with their current status.\\n\\nUse this tool to discover which child agents exist and how to address\\nthem. It returns every direct child of the current agent, including\\nchildren started with \`AgentRun\`, and never lists grandchildren. Historical\\nswarm child records remain readable, but they are not a new dispatch path.\\nAfter a context compaction, or whenever you are unsure which children are\\nstill around, call this tool instead of guessing an id or name.\\n\\nEach entry carries:\\n\\n- \`agent_id\` — the generated id. Pass it to \`AgentRun\` \`resume\` or\\n  \`AgentSend\`.\\n- \`name\` — present only when the child was started with the \`name\`\\n  parameter of the \`AgentRun\` tool. Use that name in place of \`agent_id\`\\n  when addressing the same child.\\n- \`profile\` — the child's agent type.\\n- \`status\` — \`running\` while the child is starting, running, or cancelling,\\n  even if its previous background task has settled. A broken live executor\\n  is \`errored\`. Otherwise the latest background task determines \`running\`,\\n  \`completed\`, \`interrupted\`, or \`errored\`; without one, the child is\\n  \`untracked\`. An unrecognized task state is \`unknown\`.\\n  \`running\` does not guarantee an active background task or a future task\\n  completion notification; use \`TaskList\` to inspect tracked background work.\\n- \`swarm_item\` — present when a retained historical swarm child carries an\\n  item label.\\n\\nGuidelines:\\n\\n- Prefer the default \`include_finished=false\`, which lists running\\n  children and children that are idle because no background task is\\n  tracking them. Pass \`include_finished=true\` only when you need\\n  children whose latest background task has already finished or failed.\\n- At most 50 entries are returned, running children first. If more\\n  children matched, \`omitted\` is the count that did not fit.\\n- This tool only lists children; it does not start, stop, or message\\n  them.\\n- This tool is read-only and does not change any state, so it is always\\n  safe to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "include_finished": { "default": false, "description": "When true, also include finished or errored children. The default includes live executions even after their background task settles, and idle children with no tracking task.", "type": "boolean" } }, "additionalProperties": false } }, { "name": "AgentRun", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- \`description\` is a required short task description (3-5 words) for UI display.\\n- When the task continues earlier work a subagent already did, pass that child's \`name\` or agent id as \`resume\` instead of spawning a fresh instance — the continued agent keeps its prior context.\\n- Pass \`name\` when you expect to come back to the same child: a stable name is easier to carry across turns than a generated id, and \`AgentList\` and \`AgentSend\` accept it too.\\n- For a new role, \`profile_file\` loads an explicit Agent Markdown file from an absolute or workspace-relative path. It is a role definition, not a shared prompt template, and is mutually exclusive with \`profile\`, \`route\`, and \`resume\`.\\n- When using \`resume\`, omit \`profile\`, \`profile_file\`, and \`route\`. Omit \`effort\` to keep the saved effort, or pass it to apply on the next idle run. Changing \`model_alias\` to a different canonical model requires \`allow_model_change: true\`; a request resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions still apply. An external executor that cannot change a resumed thread binding returns an error instead of recreating the thread or executor.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n- If a subagent times out, continue the same agent instead of starting over.\\n\\nWhen NOT to use AgentRun: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\nSubagents can use \`AgentNotify\` when their saved binding permits it, but only if the parent must change its actions before the final result arrives; do not send startup confirmations, routine progress, completion notices, or final-result copies.\\n\\n\\nSubagent timeout: 2 hours.\\n\\nWhen \`background=true\`, the subagent runs detached from this turn and its result arrives through automatic completion notification. For an interactive main agent (root), completion starts a follow-up turn when root is idle, without another user prompt. Continue independent work or end the current turn normally when none remains. Ending the turn leaves the background task running and the session open; it does not mean the overall task is complete. Never fabricate or predict the result.\\n\\nChoose foreground execution (omit \`background\`) when the result must be returned synchronously in the same turn. An interactive root can use \`background=true\` even when its next step depends on the result and no independent work remains. Do not keep root's turn open just to wait for that notification with TaskWait, TaskOutput or AgentList polling, sleep, or timed loops. Use TaskWait only for a genuine same-turn synchronization requirement; if automatic notification is unavailable, choose whether to wait based on the task's actual needs.\\n\\nIf you are a subagent, handle your own outstanding dependencies before returning your final result to your parent. Your completion returns that result once; ending an interactive root's turn is different from delivering a subagent's final receipt.\\n\\n\\nAvailable agent profiles (pass via profile):\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Allowed models: mock-model\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval.\\n- general: Bounded general-purpose subagent for analysis, implementation, verification, and writing. Cannot spawn further agents. Use this agent when the delegated task does not name a more specific role: bounded analysis, code changes, command execution, verification, research synthesis, or writing. It has file-editing and shell tools but no agent-coordination tools, so it cannot delegate further.\\n  Allowed models: mock-model\\n  Tools: Read, ReadMediaFile, Glob, Grep, Bash, Edit, Write, WebSearch, FetchURL, Skill, TodoList, TaskList, TaskOutput, TaskStop\\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval.\\n\\nModel aliases available across the targets above: mock-model\\nModel alias and Thinking effort under each profile are defaults. Omit model_alias and effort to use the target defaults; do not assume they copy your model or effort. Set model_alias to inherit explicitly (in a profile, route, caller lease, or AgentRun) to use your current bound model and effective thinking effort; an explicit effort or profile thinking_effort pin takes priority. Executable explicit overrides are accepted; deviations from role model/effort guidance, caller lease pins, or route pins produce binding advisories. Machine deny rules, missing models, unsupported efforts, and executor restrictions remain errors. A model listed for another target is only a recommendation for that target. If no model is bound, pass model_alias explicitly.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "profile": { "description": "One of the available agent profiles (see \\"Available agent profiles\\" in this tool description). When omitted, an explicitly configured [subagent].default_profile is used; otherwise the built-in general-purpose subagent prompt is used. An explicitly blank default requires a target.", "type": "string" }, "route": { "description": "Named profile route for a new subagent. The base profile is derived from the route when profile is omitted.", "type": "string", "minLength": 1 }, "name": { "description": "Optional stable name for the new subagent, unique within this session (lowercase letters, digits, and underscores; \\"root\\" is reserved). Use it to address the same agent again with resume, AgentSend, or AgentList instead of tracking its generated ID. Rejected together with resume.", "type": "string", "minLength": 1 }, "profile_file": { "description": "Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "allow_model_change": { "description": "Required true when resume explicitly changes model_alias to a different canonical model. Does not bypass role, caller, route or executor restrictions.", "type": "boolean" }, "allow_parent_notify": { "description": "Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.", "type": "boolean" }, "resume": { "description": "Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias also requires allow_model_change: true.", "type": "string" }, "background": { "description": "If true, return immediately and deliver the result through automatic completion notification. An interactive main agent (root) can end its turn while the subagent runs. Omit when the result must be returned synchronously in the same turn.", "type": "boolean" }, "model_alias": { "description": "Omit to use the target default model. Set model_alias to \\"inherit\\" to explicitly bind the caller's current model and effective thinking effort (unless effort or profile thinking_effort is pinned). Other aliases must resolve to a configured model; no silent caller-model fallback.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "effort": { "description": "Omit to use the target default thinking effort; with model_alias: inherit, it follows the caller unless the target pins thinking_effort. An explicit effort overrides that default and must be supported by the target.", "type": "string", "minLength": 1, "pattern": "\\\\S" } }, "required": [ "prompt", "description" ], "additionalProperties": false, "allOf": [ { "not": { "allOf": [ { "required": [ "resume" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "profile_file" ] }, { "required": [ "route" ] }, { "required": [ "name" ] } ] } ] } }, { "not": { "allOf": [ { "required": [ "profile_file" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "route" ] } ] } ] } }, { "if": { "required": [ "allow_model_change" ] }, "then": { "required": [ "resume", "model_alias" ] } } ] } }, { "name": "AgentSend", "description": "Queue a message in a direct child agent's mailbox. A running native child receives it in its active turn; an idle resumable child starts a new run with the message; other messages remain queued until a run can accept them.\\n\\nIf a child using the native executor is running, the message is steered into the active turn: it is injected at the next step boundary. This tool returns as soon as the message is durably queued — it does not wait for injection, so \`status\` normally reads \`queued\` even when delivery lands a moment later. An idle child is resumed in the background through the normal AgentRun path, including external-executor children and persisted children whose idle scope was released. A running external child cannot accept mailbox messages mid-turn, so its message stays queued until its next run. Children that are starting or cancelling are not restarted by this tool, and a child that can no longer be resumed returns an error.\\n\\nWho you can address:\\n\\n- Any **direct** child of the current agent — including unnamed children from \`AgentRun\`. Grandchildren are not reachable; send from their parent instead. Historical swarm children that remain in the session can still be addressed by agent id.\\n- Identify the child by the stable \`name\` you passed to \`AgentRun\`, or by its agent id. Anonymous \`AgentRun\` children and retained historical swarm children have no name; use the agent id.\\n- Names are unique within the session and come only from the \`name\` parameter of \`AgentRun\`. Do not invent names. If you do not know a valid name or agent id, call \`AgentList\` first.\\n\\nGuidelines:\\n\\n- \`target\` accepts either a child name or an agent id. If more than one direct child matches, or none do, the tool fails; call \`AgentList\` and retry with an unambiguous value.\\n- \`message\` must be non-empty. Write it as a note the child will read later — it will not see this conversation.\\n- A full mailbox means the child has too many unread queued messages. Wait until it consumes some, then retry.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "target": { "type": "string", "minLength": 1, "description": "Name or agent id of a direct child. Names come from the \`name\` parameter of the Agent tool; unnamed children are addressed by agent id. Call AgentList when unsure." }, "message": { "type": "string", "description": "Non-empty message to queue in the child mailbox. A running native child receives it at the next step boundary; an idle resumable child starts a new run; a running external child receives it on its next run." } }, "required": [ "target", "message" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. Set \`lifetime=service\` only for a long-running server, watcher, or listener; omitted lifetime is finite work whose completion may unblock queued messages. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use \`TaskStop\` only if the task must be cancelled.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "lifetime": { "description": "Whether background work is finite or a long-running service.", "type": "string", "enum": [ "finite", "service" ] }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n\\nA good objective is a completion contract, not a task description. Prefer proof over effort:\\nname the finish line concretely (a passing test suite, a zero-match search, a file that now\\nexists), state what the work may not touch, and include a stop rule for blockers (\\"if the\\nexternal service is down, record it and report\\") so the run ends honestly instead of forcing\\na pass. Queue-shaped objectives (\\"close out every failing test in test/auth\\") give the run a\\ncountable definition of done. Do not bake a turn or token budget into the objective text.\\n\\nWhen the user asks for help writing a goal, draft the wording together first: show the full\\nobjective text, put discrete choices through AskUserQuestion, and call CreateGoal only after\\nthe user approves the wording.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task.\\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - involves more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\\n- Use EnterPlanMode only when planning itself adds value.\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`). You may create new native research children with \`AgentRun\`, including \`profile=\\"explore\\"\`. Their capabilities are capped at builtin Read, ReadMediaFile, Glob, Grep, WebSearch, and FetchURL, intersected with existing tool policies. They do not inherit user tools, run executable prompt prefixes, use external executors, or gain Bash, Skill, MCP, or further delegation. The ceiling persists after plan exit and on resume. In plan mode, AgentRun with a nonempty resume and AgentSend remain blocked. The parent's Bash still follows its normal permission rules; existing background tasks are not automatically stopped. This is not a system sandbox.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nList specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order. Each step should be concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, this tool exits plan mode without asking the user.\\n- In yolo and manual modes, this tool still presents the plan to the user for approval.\\n- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.\\n- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch or extract content through the native nb-search runtime; no Skill or CLI prerequisite. Minimal call: \`{ \\"url\\": \\"https://example.com\\" }\`. This is the donor URL shorthand for action \`run\`; all other defaults come from effective nb-search configuration (default representation: markdown).\\n\\nThe public nb-search fetch operations are supported unchanged: \`run\`, \`get\`, \`read\`, \`cancel\`. Run accepts \`source\` of kind \`url\`, \`inline_text\`, \`inline_bytes\` or scoped \`file\`, plus optional \`pipeline\`, \`representation\`, \`execution\`, \`idempotency_key\`, \`timeout_ms\` and \`max_content_chars\`. URL shorthand accepts the same options. Do not mix shorthand \`url\` with the action/source form. Respect the schema's media types, base64 requirements, input limits and available pipeline modes.\\n\\nFiles require an explicitly configured donor scope, a relative path within that scope, and Kiki filesystem/path admission. Admission binds the canonical path and file object identity; execution reads that same object at worker time, so in-place updates are visible. Atomic replacement or a changed file object is rejected: submit a new tool call for fresh approval instead of retrying the old job. Filesystems without a usable file identity report an error. A configured scope does not grant arbitrary host-file access or bypass sensitive-file protection. Local and inline content cannot be sent through egress pipelines; the donor enforces these restrictions. Unsupported source/pipeline/mode combinations report errors, not silent substitutions. Public URL fetching retains donor network/redirect policy; authentication walls do not become authenticated content.\\n\\nMinimal synchronous URL calls return readable content; advanced options, non-URL sources and job operations return the public donor JSON envelope, preserving document metadata and warnings. Execution defaults to sync. Async requires \`idempotency_key\`; sync must not include it. Async returns a donor job receipt, not a Kiki task. Use the same tool with get/read/cancel and job_id. Follow poll_after_ms without busy-polling. Read returns donor artifact chunks as data_base64 with byte offsets, page_size/cursor pagination and optional next_cursor; a completed job can contain a partial operation result. Preserve truncation/partial warnings and cite actual source URLs when using fetched content.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nConfigured fetch chains (default representation: markdown):\\nFetch inputs: [].\\nFetch pipelines:\\nFetch limits: {\\"max_source_bytes\\":0,\\"max_response_bytes\\":0,\\"max_content_chars\\":0,\\"max_redirects\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.\\nExplicit pipeline and representation override configured selection. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "source": { "oneOf": [ { "type": "object", "properties": { "kind": { "type": "string", "const": "url" }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "url" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_text" }, "content": { "type": "string" }, "media_type": { "type": "string", "enum": [ "text/html", "text/plain", "text/markdown" ] }, "base_url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "content", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_bytes" }, "content_base64": { "type": "string", "minLength": 1, "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, "media_type": { "type": "string", "minLength": 1, "maxLength": 256 }, "filename": { "type": "string", "minLength": 1, "maxLength": 1024 } }, "required": [ "kind", "content_base64", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "file" }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "scope": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "kind", "path", "scope" ], "additionalProperties": false } ] }, "pipeline": { "type": "string", "minLength": 1, "maxLength": 256 }, "representation": { "type": "string", "enum": [ "markdown", "text" ] }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 120000 }, "max_content_chars": { "type": "integer", "minimum": 1, "maximum": 10000000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults default to 100 matching paths. Use \`offset\` (default 0) and \`head_limit\` (default 100) to page through results. When more matches are available, the result gives the next offset; keep the other search arguments unchanged. Set \`head_limit=0\` to remove the match-count limit. Pages still stay within the character retention limit, including notices: when it is reached, only complete paths are returned, with the next offset for continuation. Large pages are saved to a file with a path for Read.\\n\\nEach call searches the current filesystem again; pagination is not a snapshot, and file changes can shift results between pages. To collect a large list, use \`head_limit=0\`, read any saved output, and follow continuation offsets if the character limit is reached. Search timeouts, traversal errors, and output capture limits can still produce partial results; the result reports these limits, and pagination cannot recover paths that were never collected. Narrow the search and retry when it is incomplete.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results and waste search time and context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\` unless you need a complete listing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nDo not use shell \`grep\` or \`rg\` directly; this tool applies workspace path, output-limit, and sensitive-file policies.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Missing or invalid paths return errors you can handle. Do not use Read for directories.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line (recover the elided content with Bash, e.g. \`cut\` or \`sed\`).\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. Omit \`n_lines\` to read up to the 1000-line cap.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and transcoded to UTF-8 for display; the status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with \`iconv\`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.\\n- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be at least 1 second and convert to a finite number of milliseconds.\\nThere is no upper duration limit. Turn and token budgets must be positive and are rounded\\nto the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a skill by its registered name (\`skill\`) or an explicit Markdown file (\`path\`), never both. A path load is local to this invocation; it does not replace a same-named registered skill, install a plugin, or execute scripts. Model-invocation restrictions also apply to path loads. Relative resources resolve from the loaded file's directory. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for the same source file (check \`path\` or \`dir\`, not just the name) with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "description": "The exact name of a skill in the current listing. Mutually exclusive with path.", "type": "string", "minLength": 1 }, "path": { "description": "An explicit Markdown skill file, absolute or relative to the workspace. Mutually exclusive with skill; loading does not register a global skill or execute scripts.", "type": "string", "minLength": 1 }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "additionalProperties": false, "oneOf": [ { "required": [ "skill" ] }, { "required": [ "path" ] } ] } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\`, \`AgentRun(background=true)\`, or \`AskUserQuestion(background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer automatic completion notifications. Use TaskOutput for a specific progress check you will act on, or to read completed output when needed.\\n- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.\\n- For an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle. Do not poll TaskOutput or switch to foreground execution merely because the next step depends on the result. A subagent still handles its own dependencies before returning its final result to its parent.\\n- For background shell commands or environments without automatic continuation, use this snapshot when the task's actual needs call for it. Use TaskWait for a genuine same-turn synchronization requirement, not repeated TaskOutput calls to keep the turn open.\\n- This tool returns structured task metadata, a bounded output preview, and an \`output_path\` when the full log is available.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- When \`full_output_available\` is true, \`output_path\` points to the full log. Use \`Read\` there if the preview is truncated; otherwise the preview is complete.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskWait", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nUse this when you explicitly need a background task's result in the same turn (a subagent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome. While waiting, no LLM requests are made.\\n\\nFor an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle; no user prompt is needed. Do not keep root's turn open just to await a dependency with TaskWait, TaskOutput or AgentList polling, sleep, or timed loops. Ending the turn leaves the task running and the session open; it does not mean the overall task is complete.\\n\\nA subagent must handle its own outstanding dependencies before returning its final result to its parent: that result is its completion receipt. The interactive root's turn-ending strategy does not authorize an early subagent receipt.\\n\\nGuidelines:\\n\\n- Reserve TaskWait for a genuine same-turn synchronization requirement. If automatic notification is unavailable, choose whether to wait based on the task's actual needs; a dependency alone does not require an interactive root to stay in the same turn.\\n- \`timeout\` is required, in seconds, from 1 to 600. Choose it for the explicit synchronous wait, not as a recurring wake-up interval.\\n- A timeout is not an error: the result lists the tasks that are still running. Reassess the same-turn requirement rather than automatically repeating the call.\\n- Without \`task_id\`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, TaskWait returns immediately without waiting.\\n- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.\\n- Waiting has no side effects on the waited tasks: TaskWait never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by TaskWait do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 600, "description": "Maximum time for an explicit same-turn wait, in seconds (1-600). A timeout returns still-running tasks without stopping them; do not automatically repeat the wait." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false } }, { "name": "ThreadCreate", "description": "Create a new independent top-level session thread. Do not use this tool unless the user explicitly asks to create a new thread or session.\\n\\n- \`title\` is optional. Without it, the first line of \`prompt\` (up to 80 characters) becomes the title, or the session uses its default name.\\n- \`cwd\` is optional and must be an absolute path to an existing directory. It may be outside the current workspace; without it, the current session's workspace root is used.\\n- \`profile\` is optional and must name an enabled main-agent profile. Without it, the default main agent is used.\\n- \`prompt\` is optional. When present, it starts the new thread immediately as its first user message. Without it, the thread stays empty until the user sends a message.\\n\\nOnly creates a new thread; it does not change the current thread. Use ThreadSend and ThreadWait to continue interacting with it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "title": { "type": "string", "minLength": 1 }, "cwd": { "type": "string", "minLength": 1 }, "profile": { "type": "string", "minLength": 1 }, "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 } }, "additionalProperties": false } }, { "name": "ThreadList", "description": "List enabled local threads. Results are newest first and can be continued with the returned cursor.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 }, "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "ThreadRead", "description": "Read completed main-agent turns from a local thread without resuming a cold thread.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 }, "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }, "required": [ "thread" ], "additionalProperties": false } }, { "name": "ThreadSend", "description": "Persist and queue a user-role peer message for another enabled local thread. Reuse the same idempotency key only for the same message.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "content": { "type": "string", "minLength": 1, "maxLength": 100000 }, "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "thread", "content", "idempotency_key" ], "additionalProperties": false } }, { "name": "ThreadWait", "description": "Wait for terminal, attention, lifecycle, or undeliverable-message activity from up to eight local threads.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "threads": { "minItems": 1, "maxItems": 8, "type": "array", "items": { "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 } }, "required": [ "thread" ], "additionalProperties": false } }, "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 60000 } }, "required": [ "threads" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n- Before starting a tracked task, mark exactly one item as \`in_progress\`\\n- Immediately after finishing a tracked task, mark it \`done\`; do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\\n- When unsure of the current state, call query mode first (omit \`todos\`) to check the list before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**Ownership:**\\n- This list belongs to the calling agent. Other agents have separate lists; you cannot read or update their lists through this tool.\\n- Existing historical shared lists remain with the main agent.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Update statuses as you make progress.\\n- When work is underway, keep exactly one task \`in_progress\`.\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "WebSearch", "description": "Search using the native nb-search runtime; no Skill or CLI prerequisite. Minimal call: \`{ \\"query\\": \\"search terms\\" }\`, which selects action \`run\`; all other defaults come from effective nb-search configuration.\\n\\nThe public nb-search search operations are supported unchanged: \`run\`, \`get\`, \`read\`, \`cancel\`. Run accepts a query string or array, optional \`lane\`, \`lanes\` or \`preset\` (mutually exclusive), \`freshness\`, \`max_results\`, \`timeout_ms\`, \`execution\` and \`idempotency_key\`. A typed output requires a single lane; multi-lane/preset selection is for ranked results. Invalid or unavailable selections fail without silently changing providers.\\n\\nExecution defaults to sync. Async requires \`idempotency_key\`; sync must not include it. Async returns the donor job receipt, not a Kiki task. Use this same tool with \`{ \\"action\\": \\"get\\", \\"job_id\\": \\"...\\" }\`, \`read\` (optional cursor/page_size), or \`cancel\`. Follow \`poll_after_ms\`; do not busy-poll. Read returns donor artifact chunks as \`data_base64\`, with byte offsets and optional next_cursor; these are not plain-text page results. A succeeded job may still contain a partial operation result.\\n\\nMinimal sync query/lane calls use compact readable output; advanced options and job operations return the public donor JSON envelope without dropping its metadata. Results can be ranked source links/snippets or typed research/documentation answers. Provider sources and synthesized answers are not independent verification. Cite relevant source URLs inline, and use FetchURL for primary-source full text when needed. Snapshot defaults, available execution modes and limits follow.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nDefault search lane: not configured. Select an available lane or preset explicitly.\\nExplicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.\\nAvailable search lanes:\\nNone available in this snapshot.\\nPresets: none.\\nSearch limits: {\\"max_queries\\":0,\\"max_results\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "query": { "anyOf": [ { "type": "string", "minLength": 1, "maxLength": 4000 }, { "minItems": 1, "maxItems": 64, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 4000 } } ] }, "lane": { "type": "string", "minLength": 1, "maxLength": 256 }, "lanes": { "minItems": 1, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 256 } }, "preset": { "type": "string", "minLength": 1, "maxLength": 256 }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "freshness": { "type": "string", "enum": [ "pd", "pw", "pm", "py" ] }, "max_results": { "type": "integer", "minimum": 1, "maximum": 100 }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 3600000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is only for new files, complete replacements, or content with little continuity; do not use it for incremental changes to existing files.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "1ae16b3fa45c92e2d432e1170869be7a2edee1db12099adbf76e9e0993061902", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "I will look it up." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 3, "tokens": 160, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 160 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } } }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } } }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: AgentList, AgentRun, AgentSend, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Lookup, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TaskWait, ThreadCreate, ThreadList, ThreadRead, ThreadSend, ThreadWait, TodoList, UpdateGoal, WebSearch, Write
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
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "1ae16b3fa45c92e2d432e1170869be7a2edee1db12099adbf76e9e0993061902", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "partId": "<uuid-6>", "delta": "The lookup result is moon-result." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 5, "tokens": 176, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 176 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is moon-result." } } }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
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
        [emit] context.append_message       { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-8>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced              { "time": "<time>", "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" } ] }
        [emit] prompt.started               { "time": "<time>", "agentId": "main", "promptId": "<msg-3>" }
        [wire] turn.prompt                  { "turnId": 1, "promptId": "<msg-3>", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-8>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [emit] turn.step.started            { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 } }
        [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-8>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot           { "hash": "10b4edc9850d935a717c7622830a6f17e71345df1bef48d7b162f7d4c4750ada", "tools": [ { "name": "AgentList", "description": "List the subagents this agent started, with their current status.\\n\\nUse this tool to discover which child agents exist and how to address\\nthem. It returns every direct child of the current agent, including\\nchildren started with \`AgentRun\`, and never lists grandchildren. Historical\\nswarm child records remain readable, but they are not a new dispatch path.\\nAfter a context compaction, or whenever you are unsure which children are\\nstill around, call this tool instead of guessing an id or name.\\n\\nEach entry carries:\\n\\n- \`agent_id\` — the generated id. Pass it to \`AgentRun\` \`resume\` or\\n  \`AgentSend\`.\\n- \`name\` — present only when the child was started with the \`name\`\\n  parameter of the \`AgentRun\` tool. Use that name in place of \`agent_id\`\\n  when addressing the same child.\\n- \`profile\` — the child's agent type.\\n- \`status\` — \`running\` while the child is starting, running, or cancelling,\\n  even if its previous background task has settled. A broken live executor\\n  is \`errored\`. Otherwise the latest background task determines \`running\`,\\n  \`completed\`, \`interrupted\`, or \`errored\`; without one, the child is\\n  \`untracked\`. An unrecognized task state is \`unknown\`.\\n  \`running\` does not guarantee an active background task or a future task\\n  completion notification; use \`TaskList\` to inspect tracked background work.\\n- \`swarm_item\` — present when a retained historical swarm child carries an\\n  item label.\\n\\nGuidelines:\\n\\n- Prefer the default \`include_finished=false\`, which lists running\\n  children and children that are idle because no background task is\\n  tracking them. Pass \`include_finished=true\` only when you need\\n  children whose latest background task has already finished or failed.\\n- At most 50 entries are returned, running children first. If more\\n  children matched, \`omitted\` is the count that did not fit.\\n- This tool only lists children; it does not start, stop, or message\\n  them.\\n- This tool is read-only and does not change any state, so it is always\\n  safe to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "include_finished": { "default": false, "description": "When true, also include finished or errored children. The default includes live executions even after their background task settles, and idle children with no tracking task.", "type": "boolean" } }, "additionalProperties": false } }, { "name": "AgentRun", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- \`description\` is a required short task description (3-5 words) for UI display.\\n- When the task continues earlier work a subagent already did, pass that child's \`name\` or agent id as \`resume\` instead of spawning a fresh instance — the continued agent keeps its prior context.\\n- Pass \`name\` when you expect to come back to the same child: a stable name is easier to carry across turns than a generated id, and \`AgentList\` and \`AgentSend\` accept it too.\\n- For a new role, \`profile_file\` loads an explicit Agent Markdown file from an absolute or workspace-relative path. It is a role definition, not a shared prompt template, and is mutually exclusive with \`profile\`, \`route\`, and \`resume\`.\\n- When using \`resume\`, omit \`profile\`, \`profile_file\`, and \`route\`. Omit \`effort\` to keep the saved effort, or pass it to apply on the next idle run. Changing \`model_alias\` to a different canonical model requires \`allow_model_change: true\`; a request resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions still apply. An external executor that cannot change a resumed thread binding returns an error instead of recreating the thread or executor.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n- If a subagent times out, continue the same agent instead of starting over.\\n\\nWhen NOT to use AgentRun: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\nSubagents can use \`AgentNotify\` when their saved binding permits it, but only if the parent must change its actions before the final result arrives; do not send startup confirmations, routine progress, completion notices, or final-result copies.\\n\\n\\nSubagent timeout: 2 hours.\\n\\nWhen \`background=true\`, the subagent runs detached from this turn and its result arrives through automatic completion notification. For an interactive main agent (root), completion starts a follow-up turn when root is idle, without another user prompt. Continue independent work or end the current turn normally when none remains. Ending the turn leaves the background task running and the session open; it does not mean the overall task is complete. Never fabricate or predict the result.\\n\\nChoose foreground execution (omit \`background\`) when the result must be returned synchronously in the same turn. An interactive root can use \`background=true\` even when its next step depends on the result and no independent work remains. Do not keep root's turn open just to wait for that notification with TaskWait, TaskOutput or AgentList polling, sleep, or timed loops. Use TaskWait only for a genuine same-turn synchronization requirement; if automatic notification is unavailable, choose whether to wait based on the task's actual needs.\\n\\nIf you are a subagent, handle your own outstanding dependencies before returning your final result to your parent. Your completion returns that result once; ending an interactive root's turn is different from delivering a subagent's final receipt.\\n\\n\\nAvailable agent profiles (pass via profile):\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Allowed models: mock-model\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval.\\n- general: Bounded general-purpose subagent for analysis, implementation, verification, and writing. Cannot spawn further agents. Use this agent when the delegated task does not name a more specific role: bounded analysis, code changes, command execution, verification, research synthesis, or writing. It has file-editing and shell tools but no agent-coordination tools, so it cannot delegate further.\\n  Allowed models: mock-model\\n  Tools: Read, ReadMediaFile, Glob, Grep, Bash, Edit, Write, WebSearch, FetchURL, Skill, TodoList, TaskList, TaskOutput, TaskStop\\n  Tool availability is conditional on the child runtime, feature configuration, and invocation approval.\\n\\nModel aliases available across the targets above: mock-model\\nModel alias and Thinking effort under each profile are defaults. Omit model_alias and effort to use the target defaults; do not assume they copy your model or effort. Set model_alias to inherit explicitly (in a profile, route, caller lease, or AgentRun) to use your current bound model and effective thinking effort; an explicit effort or profile thinking_effort pin takes priority. Executable explicit overrides are accepted; deviations from role model/effort guidance, caller lease pins, or route pins produce binding advisories. Machine deny rules, missing models, unsupported efforts, and executor restrictions remain errors. A model listed for another target is only a recommendation for that target. If no model is bound, pass model_alias explicitly.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "profile": { "description": "One of the available agent profiles (see \\"Available agent profiles\\" in this tool description). When omitted, an explicitly configured [subagent].default_profile is used; otherwise the built-in general-purpose subagent prompt is used. An explicitly blank default requires a target.", "type": "string" }, "route": { "description": "Named profile route for a new subagent. The base profile is derived from the route when profile is omitted.", "type": "string", "minLength": 1 }, "name": { "description": "Optional stable name for the new subagent, unique within this session (lowercase letters, digits, and underscores; \\"root\\" is reserved). Use it to address the same agent again with resume, AgentSend, or AgentList instead of tracking its generated ID. Rejected together with resume.", "type": "string", "minLength": 1 }, "profile_file": { "description": "Explicit profile Markdown file, absolute or workspace-relative. Only for new agents; mutually exclusive with profile and route. This is a role definition, not a shared prompt template.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "allow_model_change": { "description": "Required true when resume explicitly changes model_alias to a different canonical model. Does not bypass role, caller, route or executor restrictions.", "type": "boolean" }, "allow_parent_notify": { "description": "Override AgentNotify availability for this child. On a new agent, omission uses the selected profile setting, which defaults to enabled. On resume, omission preserves the saved setting. This cannot override the global [agents].notify_parent switch or tool policy.", "type": "boolean" }, "resume": { "description": "Name or agent ID of an existing direct child. Do not pass name, profile, profile_file, or route. Omitted effort/model keep the saved binding. An explicit effort applies to the next idle run; changing model_alias also requires allow_model_change: true.", "type": "string" }, "background": { "description": "If true, return immediately and deliver the result through automatic completion notification. An interactive main agent (root) can end its turn while the subagent runs. Omit when the result must be returned synchronously in the same turn.", "type": "boolean" }, "model_alias": { "description": "Omit to use the target default model. Set model_alias to \\"inherit\\" to explicitly bind the caller's current model and effective thinking effort (unless effort or profile thinking_effort is pinned). Other aliases must resolve to a configured model; no silent caller-model fallback.", "type": "string", "minLength": 1, "pattern": "\\\\S" }, "effort": { "description": "Omit to use the target default thinking effort; with model_alias: inherit, it follows the caller unless the target pins thinking_effort. An explicit effort overrides that default and must be supported by the target.", "type": "string", "minLength": 1, "pattern": "\\\\S" } }, "required": [ "prompt", "description" ], "additionalProperties": false, "allOf": [ { "not": { "allOf": [ { "required": [ "resume" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "profile_file" ] }, { "required": [ "route" ] }, { "required": [ "name" ] } ] } ] } }, { "not": { "allOf": [ { "required": [ "profile_file" ] }, { "anyOf": [ { "required": [ "profile" ] }, { "required": [ "route" ] } ] } ] } }, { "if": { "required": [ "allow_model_change" ] }, "then": { "required": [ "resume", "model_alias" ] } } ] } }, { "name": "AgentSend", "description": "Queue a message in a direct child agent's mailbox. A running native child receives it in its active turn; an idle resumable child starts a new run with the message; other messages remain queued until a run can accept them.\\n\\nIf a child using the native executor is running, the message is steered into the active turn: it is injected at the next step boundary. This tool returns as soon as the message is durably queued — it does not wait for injection, so \`status\` normally reads \`queued\` even when delivery lands a moment later. An idle child is resumed in the background through the normal AgentRun path, including external-executor children and persisted children whose idle scope was released. A running external child cannot accept mailbox messages mid-turn, so its message stays queued until its next run. Children that are starting or cancelling are not restarted by this tool, and a child that can no longer be resumed returns an error.\\n\\nWho you can address:\\n\\n- Any **direct** child of the current agent — including unnamed children from \`AgentRun\`. Grandchildren are not reachable; send from their parent instead. Historical swarm children that remain in the session can still be addressed by agent id.\\n- Identify the child by the stable \`name\` you passed to \`AgentRun\`, or by its agent id. Anonymous \`AgentRun\` children and retained historical swarm children have no name; use the agent id.\\n- Names are unique within the session and come only from the \`name\` parameter of \`AgentRun\`. Do not invent names. If you do not know a valid name or agent id, call \`AgentList\` first.\\n\\nGuidelines:\\n\\n- \`target\` accepts either a child name or an agent id. If more than one direct child matches, or none do, the tool fails; call \`AgentList\` and retry with an unambiguous value.\\n- \`message\` must be non-empty. Write it as a note the child will read later — it will not see this conversation.\\n- A full mailbox means the child has too many unread queued messages. Wait until it consumes some, then retry.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "target": { "type": "string", "minLength": 1, "description": "Name or agent id of a direct child. Names come from the \`name\` parameter of the Agent tool; unnamed children are addressed by agent id. Call AgentList when unsure." }, "message": { "type": "string", "description": "Non-empty message to queue in the child mailbox. A running native child receives it at the next step boundary; an idle resumable child starts a new run; a running external child receives it on its next run." } }, "required": [ "target", "message" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. Set \`lifetime=service\` only for a long-running server, watcher, or listener; omitted lifetime is finite work whose completion may unblock queued messages. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use \`TaskStop\` only if the task must be cancelled.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "lifetime": { "description": "Whether background work is finite or a long-running service.", "type": "string", "enum": [ "finite", "service" ] }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n\\nA good objective is a completion contract, not a task description. Prefer proof over effort:\\nname the finish line concretely (a passing test suite, a zero-match search, a file that now\\nexists), state what the work may not touch, and include a stop rule for blockers (\\"if the\\nexternal service is down, record it and report\\") so the run ends honestly instead of forcing\\na pass. Queue-shaped objectives (\\"close out every failing test in test/auth\\") give the run a\\ncountable definition of done. Do not bake a turn or token budget into the objective text.\\n\\nWhen the user asks for help writing a goal, draft the wording together first: show the full\\nobjective text, put discrete choices through AskUserQuestion, and call CreateGoal only after\\nthe user approves the wording.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task.\\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - involves more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\\n- Use EnterPlanMode only when planning itself adds value.\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`). You may create new native research children with \`AgentRun\`, including \`profile=\\"explore\\"\`. Their capabilities are capped at builtin Read, ReadMediaFile, Glob, Grep, WebSearch, and FetchURL, intersected with existing tool policies. They do not inherit user tools, run executable prompt prefixes, use external executors, or gain Bash, Skill, MCP, or further delegation. The ceiling persists after plan exit and on resume. In plan mode, AgentRun with a nonempty resume and AgentSend remain blocked. The parent's Bash still follows its normal permission rules; existing background tasks are not automatically stopped. This is not a system sandbox.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nList specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order. Each step should be concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, this tool exits plan mode without asking the user.\\n- In yolo and manual modes, this tool still presents the plan to the user for approval.\\n- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.\\n- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch or extract content through the native nb-search runtime; no Skill or CLI prerequisite. Minimal call: \`{ \\"url\\": \\"https://example.com\\" }\`. This is the donor URL shorthand for action \`run\`; all other defaults come from effective nb-search configuration (default representation: markdown).\\n\\nThe public nb-search fetch operations are supported unchanged: \`run\`, \`get\`, \`read\`, \`cancel\`. Run accepts \`source\` of kind \`url\`, \`inline_text\`, \`inline_bytes\` or scoped \`file\`, plus optional \`pipeline\`, \`representation\`, \`execution\`, \`idempotency_key\`, \`timeout_ms\` and \`max_content_chars\`. URL shorthand accepts the same options. Do not mix shorthand \`url\` with the action/source form. Respect the schema's media types, base64 requirements, input limits and available pipeline modes.\\n\\nFiles require an explicitly configured donor scope, a relative path within that scope, and Kiki filesystem/path admission. Admission binds the canonical path and file object identity; execution reads that same object at worker time, so in-place updates are visible. Atomic replacement or a changed file object is rejected: submit a new tool call for fresh approval instead of retrying the old job. Filesystems without a usable file identity report an error. A configured scope does not grant arbitrary host-file access or bypass sensitive-file protection. Local and inline content cannot be sent through egress pipelines; the donor enforces these restrictions. Unsupported source/pipeline/mode combinations report errors, not silent substitutions. Public URL fetching retains donor network/redirect policy; authentication walls do not become authenticated content.\\n\\nMinimal synchronous URL calls return readable content; advanced options, non-URL sources and job operations return the public donor JSON envelope, preserving document metadata and warnings. Execution defaults to sync. Async requires \`idempotency_key\`; sync must not include it. Async returns a donor job receipt, not a Kiki task. Use the same tool with get/read/cancel and job_id. Follow poll_after_ms without busy-polling. Read returns donor artifact chunks as data_base64 with byte offsets, page_size/cursor pagination and optional next_cursor; a completed job can contain a partial operation result. Preserve truncation/partial warnings and cite actual source URLs when using fetched content.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nConfigured fetch chains (default representation: markdown):\\nFetch inputs: [].\\nFetch pipelines:\\nFetch limits: {\\"max_source_bytes\\":0,\\"max_response_bytes\\":0,\\"max_content_chars\\":0,\\"max_redirects\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.\\nExplicit pipeline and representation override configured selection. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "source": { "oneOf": [ { "type": "object", "properties": { "kind": { "type": "string", "const": "url" }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "url" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_text" }, "content": { "type": "string" }, "media_type": { "type": "string", "enum": [ "text/html", "text/plain", "text/markdown" ] }, "base_url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "required": [ "kind", "content", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "inline_bytes" }, "content_base64": { "type": "string", "minLength": 1, "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, "media_type": { "type": "string", "minLength": 1, "maxLength": 256 }, "filename": { "type": "string", "minLength": 1, "maxLength": 1024 } }, "required": [ "kind", "content_base64", "media_type" ], "additionalProperties": false }, { "type": "object", "properties": { "kind": { "type": "string", "const": "file" }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "scope": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "kind", "path", "scope" ], "additionalProperties": false } ] }, "pipeline": { "type": "string", "minLength": 1, "maxLength": 256 }, "representation": { "type": "string", "enum": [ "markdown", "text" ] }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 120000 }, "max_content_chars": { "type": "integer", "minimum": 1, "maximum": 10000000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 }, "url": { "type": "string", "maxLength": 4096, "format": "uri" } }, "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults default to 100 matching paths. Use \`offset\` (default 0) and \`head_limit\` (default 100) to page through results. When more matches are available, the result gives the next offset; keep the other search arguments unchanged. Set \`head_limit=0\` to remove the match-count limit. Pages still stay within the character retention limit, including notices: when it is reached, only complete paths are returned, with the next offset for continuation. Large pages are saved to a file with a path for Read.\\n\\nEach call searches the current filesystem again; pagination is not a snapshot, and file changes can shift results between pages. To collect a large list, use \`head_limit=0\`, read any saved output, and follow continuation offsets if the character limit is reached. Search timeouts, traversal errors, and output capture limits can still produce partial results; the result reports these limits, and pagination cannot recover paths that were never collected. Narrow the search and retry when it is incomplete.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results and waste search time and context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\` unless you need a complete listing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nDo not use shell \`grep\` or \`rg\` directly; this tool applies workspace path, output-limit, and sensitive-file policies.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Missing or invalid paths return errors you can handle. Do not use Read for directories.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line (recover the elided content with Bash, e.g. \`cut\` or \`sed\`).\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. Omit \`n_lines\` to read up to the 1000-line cap.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and transcoded to UTF-8 for display; the status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with \`iconv\`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.\\n- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be at least 1 second and convert to a finite number of milliseconds.\\nThere is no upper duration limit. Turn and token budgets must be positive and are rounded\\nto the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a skill by its registered name (\`skill\`) or an explicit Markdown file (\`path\`), never both. A path load is local to this invocation; it does not replace a same-named registered skill, install a plugin, or execute scripts. Model-invocation restrictions also apply to path loads. Relative resources resolve from the loaded file's directory. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for the same source file (check \`path\` or \`dir\`, not just the name) with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "description": "The exact name of a skill in the current listing. Mutually exclusive with path.", "type": "string", "minLength": 1 }, "path": { "description": "An explicit Markdown skill file, absolute or relative to the workspace. Mutually exclusive with skill; loading does not register a global skill or execute scripts.", "type": "string", "minLength": 1 }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "additionalProperties": false, "oneOf": [ { "required": [ "skill" ] }, { "required": [ "path" ] } ] } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\`, \`AgentRun(background=true)\`, or \`AskUserQuestion(background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer automatic completion notifications. Use TaskOutput for a specific progress check you will act on, or to read completed output when needed.\\n- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.\\n- For an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle. Do not poll TaskOutput or switch to foreground execution merely because the next step depends on the result. A subagent still handles its own dependencies before returning its final result to its parent.\\n- For background shell commands or environments without automatic continuation, use this snapshot when the task's actual needs call for it. Use TaskWait for a genuine same-turn synchronization requirement, not repeated TaskOutput calls to keep the turn open.\\n- This tool returns structured task metadata, a bounded output preview, and an \`output_path\` when the full log is available.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- When \`full_output_available\` is true, \`output_path\` points to the full log. Use \`Read\` there if the preview is truncated; otherwise the preview is complete.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskWait", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nUse this when you explicitly need a background task's result in the same turn (a subagent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome. While waiting, no LLM requests are made.\\n\\nFor an interactive main agent (root) whose background subagents have automatic completion notification, continue independent work or end the current turn normally when none remains. Completion starts a follow-up turn when root is idle; no user prompt is needed. Do not keep root's turn open just to await a dependency with TaskWait, TaskOutput or AgentList polling, sleep, or timed loops. Ending the turn leaves the task running and the session open; it does not mean the overall task is complete.\\n\\nA subagent must handle its own outstanding dependencies before returning its final result to its parent: that result is its completion receipt. The interactive root's turn-ending strategy does not authorize an early subagent receipt.\\n\\nGuidelines:\\n\\n- Reserve TaskWait for a genuine same-turn synchronization requirement. If automatic notification is unavailable, choose whether to wait based on the task's actual needs; a dependency alone does not require an interactive root to stay in the same turn.\\n- \`timeout\` is required, in seconds, from 1 to 600. Choose it for the explicit synchronous wait, not as a recurring wake-up interval.\\n- A timeout is not an error: the result lists the tasks that are still running. Reassess the same-turn requirement rather than automatically repeating the call.\\n- Without \`task_id\`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, TaskWait returns immediately without waiting.\\n- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.\\n- Waiting has no side effects on the waited tasks: TaskWait never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by TaskWait do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 600, "description": "Maximum time for an explicit same-turn wait, in seconds (1-600). A timeout returns still-running tasks without stopping them; do not automatically repeat the wait." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false } }, { "name": "ThreadCreate", "description": "Create a new independent top-level session thread. Do not use this tool unless the user explicitly asks to create a new thread or session.\\n\\n- \`title\` is optional. Without it, the first line of \`prompt\` (up to 80 characters) becomes the title, or the session uses its default name.\\n- \`cwd\` is optional and must be an absolute path to an existing directory. It may be outside the current workspace; without it, the current session's workspace root is used.\\n- \`profile\` is optional and must name an enabled main-agent profile. Without it, the default main agent is used.\\n- \`prompt\` is optional. When present, it starts the new thread immediately as its first user message. Without it, the thread stays empty until the user sends a message.\\n\\nOnly creates a new thread; it does not change the current thread. Use ThreadSend and ThreadWait to continue interacting with it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "title": { "type": "string", "minLength": 1 }, "cwd": { "type": "string", "minLength": 1 }, "profile": { "type": "string", "minLength": 1 }, "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 } }, "additionalProperties": false } }, { "name": "ThreadList", "description": "List enabled local threads. Results are newest first and can be continued with the returned cursor.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 }, "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "ThreadRead", "description": "Read completed main-agent turns from a local thread without resuming a cold thread.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 }, "limit": { "type": "integer", "minimum": 1, "maximum": 100 } }, "required": [ "thread" ], "additionalProperties": false } }, { "name": "ThreadSend", "description": "Persist and queue a user-role peer message for another enabled local thread. Reuse the same idempotency key only for the same message.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "content": { "type": "string", "minLength": 1, "maxLength": 100000 }, "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "thread", "content", "idempotency_key" ], "additionalProperties": false } }, { "name": "ThreadWait", "description": "Wait for terminal, attention, lifecycle, or undeliverable-message activity from up to eight local threads.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "threads": { "minItems": 1, "maxItems": 8, "type": "array", "items": { "type": "object", "properties": { "thread": { "type": "object", "properties": { "host_id": { "type": "string", "minLength": 1, "maxLength": 256 }, "workspace_id": { "type": "string", "minLength": 1, "maxLength": 512 }, "session_id": { "type": "string", "minLength": 1, "maxLength": 256 } }, "required": [ "host_id", "workspace_id", "session_id" ], "additionalProperties": false }, "cursor": { "type": "string", "minLength": 1, "maxLength": 4096 } }, "required": [ "thread" ], "additionalProperties": false } }, "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 60000 } }, "required": [ "threads" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n- Before starting a tracked task, mark exactly one item as \`in_progress\`\\n- Immediately after finishing a tracked task, mark it \`done\`; do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\\n- When unsure of the current state, call query mode first (omit \`todos\`) to check the list before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**Ownership:**\\n- This list belongs to the calling agent. Other agents have separate lists; you cannot read or update their lists through this tool.\\n- Existing historical shared lists remain with the main agent.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Update statuses as you make progress.\\n- When work is underway, keep exactly one task \`in_progress\`.\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "WebSearch", "description": "Search using the native nb-search runtime; no Skill or CLI prerequisite. Minimal call: \`{ \\"query\\": \\"search terms\\" }\`, which selects action \`run\`; all other defaults come from effective nb-search configuration.\\n\\nThe public nb-search search operations are supported unchanged: \`run\`, \`get\`, \`read\`, \`cancel\`. Run accepts a query string or array, optional \`lane\`, \`lanes\` or \`preset\` (mutually exclusive), \`freshness\`, \`max_results\`, \`timeout_ms\`, \`execution\` and \`idempotency_key\`. A typed output requires a single lane; multi-lane/preset selection is for ranked results. Invalid or unavailable selections fail without silently changing providers.\\n\\nExecution defaults to sync. Async requires \`idempotency_key\`; sync must not include it. Async returns the donor job receipt, not a Kiki task. Use this same tool with \`{ \\"action\\": \\"get\\", \\"job_id\\": \\"...\\" }\`, \`read\` (optional cursor/page_size), or \`cancel\`. Follow \`poll_after_ms\`; do not busy-poll. Read returns donor artifact chunks as \`data_base64\`, with byte offsets and optional next_cursor; these are not plain-text page results. A succeeded job may still contain a partial operation result.\\n\\nMinimal sync query/lane calls use compact readable output; advanced options and job operations return the public donor JSON envelope without dropping its metadata. Results can be ranked source links/snippets or typed research/documentation answers. Provider sources and synthesized answers are not independent verification. Cite relevant source URLs inline, and use FetchURL for primary-source full text when needed. Snapshot defaults, available execution modes and limits follow.\\n\\n\\nCapability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.\\nConfiguration source unavailable: TEST_SEARCH_NOT_CONFIGURED.\\nDefault search lane: not configured. Select an available lane or preset explicitly.\\nExplicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.\\nAvailable search lanes:\\nNone available in this snapshot.\\nPresets: none.\\nSearch limits: {\\"max_queries\\":0,\\"max_results\\":0,\\"max_timeout_ms\\":0,\\"max_inline_bytes\\":0}.", "parameters": { "type": "object", "properties": { "action": { "type": "string", "enum": [ "run", "get", "read", "cancel" ] }, "query": { "anyOf": [ { "type": "string", "minLength": 1, "maxLength": 4000 }, { "minItems": 1, "maxItems": 64, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 4000 } } ] }, "lane": { "type": "string", "minLength": 1, "maxLength": 256 }, "lanes": { "minItems": 1, "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 256 } }, "preset": { "type": "string", "minLength": 1, "maxLength": 256 }, "execution": { "type": "string", "enum": [ "sync", "async" ] }, "idempotency_key": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" }, "freshness": { "type": "string", "enum": [ "pd", "pw", "pm", "py" ] }, "max_results": { "type": "integer", "minimum": 1, "maximum": 100 }, "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 3600000 }, "job_id": { "type": "string", "format": "uuid", "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$" }, "cursor": { "type": "string", "minLength": 1, "maxLength": 2048 }, "page_size": { "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is only for new files, complete replacements, or content with little continuity; do not use it for incremental changes to existing files.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                  { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "10b4edc9850d935a717c7622830a6f17e71345df1bef48d7b162f7d4c4750ada", "messageCount": 6, "turnStep": "1.1", "time": "<time>" }
        [emit] assistant.delta              { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "partId": "<uuid-9>", "delta": "No lookup tool is available." }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 1, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured      { "length": 7, "tokens": 194, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "contextTokens": 194 }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "No lookup tool is available." } } }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed          { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-8>", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-9>", "turnId": "1", "step": 1, "stepUuid": "<uuid-8>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
        [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-8>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] turn.ended                   { "turnId": 1, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                   { "time": "<time>", "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: AgentList, AgentRun, AgentSend, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TaskWait, ThreadCreate, ThreadList, ThreadRead, ThreadSend, ThreadWait, TodoList, UpdateGoal, WebSearch, Write
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
