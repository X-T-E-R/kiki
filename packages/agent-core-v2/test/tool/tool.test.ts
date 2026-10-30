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
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IBashTool } from '#/agent/tools/os/bash/bash';
import { ITaskWaitTool } from '#/agent/tools/task/task-wait/task-wait';
import { compactProfileDescriptions } from '#/agent/tools/agent/subagentDescription';
import { GENERIC_SUBAGENT_PROFILE } from '#/session/subagent/genericProfile';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { makeHookRunner } from '../features/externalHooks/runner-stub';
import { IAgentProfileService, type PreparedModelSwitchBinding, type ProfileData } from '#/agent/profile/profile';
import { IAgentModelSwitchService, type ModelSwitchReceipt } from '#/agent/modelSwitch/modelSwitch';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { IAgentRuntimeService, IAgentWorkspaceRootsSeed } from '#/agent/runtimeBinding/agentRuntime';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentExecutionService } from '#/agent/execution/execution';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  SubagentToolInputSchema,
  type SubagentToolInput,
} from '#/agent/tools/agent/agent';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, SUBAGENT_SECTION } from '#/session/subagent/configSection';
import { roleBindingAdvisories } from '#/session/subagent/modelConstraints';
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
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IFlagService } from '#/app/flag/flag';
import { normalizeAgentProfile, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { IWireService } from '#/wire/wire';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { agentMessageMaterializationsKey, agentMessageReceiptsKey } from '#/session/agentCollaboration/messageReceiptState';
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
import { createEventSnapshotter, type EventSnapshotEntry } from '../harness/snapshots';

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
      return {
        id: alias, name: alias, aliases: [], protocol: 'openai', headers: {},
        capabilities: { ...UNKNOWN_CAPABILITY, thinking: true }, supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high',
        maxContextSize: 1_000_000, alwaysThinking: false, providerName: 'test-provider',
        imagePolicy: { acceptedTypes: new Set(['image/png']), convertUnsupported: 'off' },
        authProvider: { getAuth: async () => undefined },
      } satisfies Model;
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

function prepareFixtureResumeBinding(
  data: { readonly modelAlias?: string; readonly thinkingLevel?: string; readonly allowParentNotify?: boolean },
  input: Parameters<IAgentProfileService['prepareResumeBinding']>[0] = {},
): PreparedModelSwitchBinding {
  const model = input.modelAlias ?? data.modelAlias ?? 'mock-model';
  const thinking = input.thinkingEffort ?? data.thinkingLevel ?? 'off';
  return { model, thinking, config: { modelAlias: model, thinkingLevel: thinking,
    allowParentNotify: input.allowParentNotify ?? data.allowParentNotify }, maxContextTokens: 262_144,
    reservedTokens: 1_000, assertCurrent: () => {}, syncMetadata: async () => {} };
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
      readonly bindingAdvisories?: NonNullable<ProfileData['bindingAdvisories']>;
    }
  >();
  const handles = new Map<string, IAgentScopeHandle>();
  const servicesByAgentId = new Map(options.handleServices);
  const publishedEvents: Event2[] = [];
  const switches = new Map<string, ModelSwitchReceipt>();
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (serviceId) => {
        const service = servicesByAgentId.get(agentId)?.get(serviceId);
        if (service !== undefined) return service as never;
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentScopeContext) {
          return makeAgentScopeContext({ agentId, agentScope: agentId === 'main' ? '' : `agents/${agentId}`, parentAgentId: agentId === 'main' ? undefined : 'main' }) as never;
        }
        if (serviceId === IAgentContextInjectorService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentMemorySnapshot) {
          return { _serviceBrand: undefined, getPersona: () => undefined } as never;
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
            prepareResumeBinding: async (input: Parameters<IAgentProfileService['prepareResumeBinding']>[0]) =>
              prepareFixtureResumeBinding(profileByAgentId.get(agentId) ?? {}, input),
            republishStatus: () => {},
            getEffectiveThinkingLevel: () => profileByAgentId.get(agentId)?.thinkingLevel ?? 'off',
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentModelSwitchService) {
          return {
            _serviceBrand: undefined, onDidChange: Event.None as KimiEvent<ModelSwitchReceipt>,
            hooks: { onDidCommitContextWindow: { register: () => ({ dispose() {} }), delete: () => false, run: async () => {} } },
            get: (operationId: string) => switches.get(`${agentId}:${operationId}`),
            execute: async (input, options) => {
              const saved = switches.get(`${agentId}:${input.operationId}`);
              if (saved !== undefined) return saved;
              const binding = options?.binding;
              if (binding === undefined) throw new Error('The fixture requires a prepared binding');
              binding.assertCurrent();
              const prior = handle(agentId).accessor.get(IAgentProfileService).data();
              profileByAgentId.set(agentId, { ...profileByAgentId.get(agentId)!, modelAlias: binding.model,
                thinkingLevel: binding.thinking, allowParentNotify: binding.config.allowParentNotify });
              await binding.syncMetadata();
              const receipt: ModelSwitchReceipt = { operationId: input.operationId, agentId, state: 'completed',
                fromModel: prior.modelAlias ?? binding.model, toModel: binding.model, mode: input.mode,
                binding: { model: binding.model, thinking: binding.thinking } };
              switches.set(`${agentId}:${input.operationId}`, receipt);
              return receipt;
            },
          } satisfies IAgentModelSwitchService as never;
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
        if (serviceId === IAgentTaskService) {
          return { _serviceBrand: undefined, stopAll: async () => [] } as never;
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
            state.contributeState(agentMessageReceiptsKey);
            state.contributeState(agentMessageMaterializationsKey);
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
        thinkingLevel: typeof input.binding?.thinking === 'string' ? input.binding.thinking : 'off',
        allowParentNotify: input.binding?.allowParentNotify,
        bindingAdvisories: roleBindingAdvisories({
          model: input.binding?.model ?? '',
          requestedModel: input.binding?.bindingSelection?.model?.requestedValue,
          thinking: typeof input.binding?.thinking === 'string' ? input.binding.thinking : undefined,
          requestedThinking: input.binding?.bindingSelection?.thinking?.requestedValue,
          constraints: input.binding?.resolvedProfile,
          ruleSource: `profile:${profileName}`,
          modelValueSource: input.binding?.bindingSelection?.model?.source ?? 'profile-default',
          thinkingValueSource: input.binding?.bindingSelection?.thinking?.source,
        }),
      });
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return createdHandle;
    }),
    commitCreate: () => {},
    discard: async (agentId: string) => {
      await handles.get(agentId)?.dispose();
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
  toolCallId = 'call_agent',
) {
  return executeTool(agentTool(ctx), {
    turnId: 0,
    toolCallId,
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
    { ...args, background: args.background ?? false, model_alias: needsModel ? 'mock-model' : args.model_alias },
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
  const readMetadata = () => ({
    id: 'test-session',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    agents,
  });
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as ISessionMetadata['onDidChangeMetadata'],
    read: async () => readMetadata(),
    drain: async () => {},
    snapshot: () => structuredClone(readMetadata()),
    getAgentExecutor: async (agentId: string) => agents[agentId]?.executor,
    usage: () => undefined,
    recordUsage: () => {},
    update: async () => {},
    setTitle: async () => {},
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async () => {},
    updateAgent: async (agentId, updater) => {
      const current = agents[agentId];
      if (current !== undefined) agents = { ...agents, [agentId]: updater(structuredClone(current)) };
    },
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
    expect(properties['background']?.description).toContain('main runs in background; subagents wait in foreground');
    expect(properties['background']?.description).toContain('Set false explicitly for a genuine same-turn dependency');
    expect(properties['background']?.description).toContain('including resume and goal mode');
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

describe('Default general background delivery', () => {
  let ctx: TestAgentContext;
  afterEach(async () => { await ctx.dispose(); vi.restoreAllMocks(); });

  it.each(['shipped', 'generic'] as const)('projects TaskWait for the %s leaf and collects its finite Bash dependency', async (source) => {
    const stdout = new Readable({ read() {} });
    let settle!: (code: number) => void;
    const completion = new Promise<number>((resolve) => { settle = resolve; });
    const proc: IHostProcess = {
      _serviceBrand: undefined, stdin: { write() {}, end() {} } as unknown as Writable,
      stdout, stderr: Readable.from([]), pid: 10001, exitCode: null,
      wait: () => completion, kill: async () => { settle(143); }, dispose: async () => {},
    };
    ctx = createTestAgent(
      execEnvServices({ processRunner: createFakeProcessRunner({ spawn: async () => proc }) }),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'child', parentAgentId: 'main', agentScope: 'agents/child' })),
    );
    await ctx.get(IAgentProfileService).bind({ profile: 'general', resolvedProfile: source === 'generic' ? GENERIC_SUBAGENT_PROFILE : undefined, model: 'mock-model', delegationPosition: 'sub' });
    const child = ctx;
    ctx.mockNextResponse({ type: 'text', text: 'synthetic projection' });
    await child.get(IAgentLLMRequesterService).request();
    const names = ctx.llmCalls.at(-1)!.tools.map((tool) => tool.name);
    expect(names).toContain('TaskWait');
    expect(names).toContain('Bash');
    expect(names).not.toContain('AgentRun');
    expect(names).not.toContain('AgentSend');
    const started = await executeTool(child.get(IBashTool), { turnId: 0, toolCallId: 'start', signal,
      args: { command: 'synthetic finite check', run_in_background: true, description: 'finite check' } });
    expect(started.isError).not.toBe(true);
    const taskId = child.get(IAgentTaskService).list(true)[0]!.taskId;
    let delivered = false;
    const waiting = executeTool(child.get(ITaskWaitTool), { turnId: 0, toolCallId: 'wait', signal,
      args: { timeout: 5, task_id: taskId } }).then((result) => { delivered = true; return result; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    stdout.push('finite check passed\n');
    stdout.push(null);
    settle(0);
    const result = await waiting;
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('wait_status: completed');
    expect(result.output).toContain('finite check passed');
    expect(result.output).toContain('exit_code: 0');
  });

  it.each(['profile-deny', 'flag-off'] as const)('does not restore TaskWait after %s and describes only available completion paths', async (restriction) => {
    ctx = createTestAgent(
      { initialConfig: { experimental: { task_wait: restriction !== 'flag-off' } } },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'child', parentAgentId: 'main', agentScope: 'agents/child' })),
    );
    await ctx.get(IAgentProfileService).bind({ profile: 'general', model: 'mock-model', delegationPosition: 'sub', toolOverride: restriction === 'profile-deny' ? { disallowedTools: ['TaskWait'] } : undefined });
    const child = ctx;
    ctx.mockNextResponse({ type: 'text', text: 'synthetic projection' });
    await child.get(IAgentLLMRequesterService).request();
    const tools = ctx.llmCalls.at(-1)!.tools;
    expect(tools.map((tool) => tool.name)).not.toContain('TaskWait');
    expect(tools.find((tool) => tool.name === 'Bash')!.description).toContain('No blocking task-wait tool is available');
    expect(tools.find((tool) => tool.name === 'Bash')!.description).not.toContain('call TaskWait');
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
    expect(description).toContain('Omitting `background` runs in background for main and waits in foreground for subagents');
    expect(description).toContain('main should do independent work or end its turn while waiting');
    expect(description).toContain('the task and session continue');
    expect(description).toContain('Set `background=false` explicitly for a genuine same-turn dependency');
    expect(description).toContain('Do not poll TaskWait/TaskOutput/AgentList just to keep a main turn open');
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

    expect(description).toContain('- explore: Read-only leaf for bounded code or source evidence');
    expect(description).toContain('not implementation or an independent review verdict');
    expect(description).toContain('- general: Leaf owner for bounded analysis, implementation, verification, research, or writing');
    expect(description).toContain('decisive evidence, and unresolved integration needs');
    expect(description).not.toContain('\n  Tools:');
  });

  it('truncates long profile advertisements at a word boundary with an explicit omission marker', () => {
    ctx = createTestAgent();
    const profile = normalizeAgentProfile({ name: 'bounded', description: 'bounded evidence',
      whenToUse: `Read-only leaf ${'completeword '.repeat(30)}lastword.`, renderSystemPrompt: () => ({ text: '', environment: { cwd: '', date: { disclosed: false } } }) });
    const line = compactProfileDescriptions([profile]);
    expect(line).toMatch(/completeword…$/);
    expect(line.split(': ')[1]!.length).toBeLessThanOrEqual(180);
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

    expect(description).toContain('- explore: Read-only leaf for bounded code or source evidence');
    expect(description).toContain('not implementation or an independent review verdict');
    expect(description).toContain('- general: Leaf owner for bounded analysis, implementation, verification, research, or writing');
    expect(description).toContain('decisive evidence, and unresolved integration needs');
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
      allowedSubagents: ['explore'],
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
      preferredSubagents: ['coder'],
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
      preferredSubagents: ['explore'],
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
    expect(description).toContain('not by repeating them in `prompt`');
    const properties = agentParameters()['properties'] as Record<string, { description?: string }>;
    expect(properties['model_alias']?.description).toContain('the receipt reports actual_model');
    expect(properties['prompt']?.description).toContain('not model, route or tool choices');
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

  it('model-boundary Send now releases the real AgentRun foreground wait without cancelling its tracked child', async () => {
    const childCompletion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'], runCompletion: () => childCompletion.promise });
    lifecycle.addHandle('main', 'agent');
    const context = ctx = createTestAgent(sessionService(IAgentLifecycleService, lifecycle), sessionService(ISessionSubagentService, lifecycle), sessionService(ISessionCronService, cronStub));
    await context.ready;
    const profile = context.get(IAgentProfileService);
    await profile.bind({ profile: 'agent', model: 'mock-model' });
    await context.get(ISessionMetadata).registerAgent('main', { model: 'mock-model', executor: 'native' });
    profile.update({ activeToolNames: ['AgentRun'] });
    context.get(IAgentPermissionModeService).setMode('yolo');
    context.mockNextResponse({ type: 'text', text: 'Delegating existing work.' }, { type: 'function', id: 'boundary-foreground-child', name: 'AgentRun', arguments: JSON.stringify({ prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model', background: false }) });
    context.mockNextResponse({ type: 'text', text: 'Answering on the selected model while the child continues.' });
    const prompt = context.get(IAgentPromptService);
    const active = await prompt.enqueue({ id: 'foreground-existing', message: { role: 'user', content: [{ type: 'text', text: 'Run the original child work.' }], toolCalls: [] } });
    const tasks = context.get(IAgentTaskService);
    await vi.waitFor(() => expect(tasks.list(false), JSON.stringify(context.get(IAgentContextMemoryService).get())).toHaveLength(1));
    expect(await prompt.switchModel({ operationId: 'foreground-choice', model: 'mock-model', mode: 'fresh' })).toMatchObject({ state: 'pending' });
    const original = await prompt.enqueue({ id: 'foreground-original', message: { role: 'user', content: [{ type: 'text', text: 'Use the selected model without stopping my child.' }], toolCalls: [] }, execution: { afterModelSwitch: 'foreground-choice' } });
    expect(await prompt.steer([original.id])).toEqual([original]);
    expect((await original.completion).state).toBe('completed');
    await active.completion;
    const task = tasks.list(false)[0]!;
    expect(task).toMatchObject({ detached: true, status: 'running' });
    expect(lifecycle.run.mock.calls[0]![2].signal.aborted).toBe(false);
    expect(profile.getModel()).toBe('mock-model');
    expect(prompt.getModelSwitch('foreground-choice')).toMatchObject({ state: 'completed', mode: 'fresh' });
    expect(JSON.stringify(context.llmCalls[1])).toContain('Use the selected model without stopping my child.');
    childCompletion.resolve({ summary: 'child finished normally' });
    expect(await tasks.wait(task.taskId)).toMatchObject({ detached: true, status: 'completed' });
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
    restrict = false,
  ): ISessionAgentProfileCatalog {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      allowedSubagents: restrict ? allowlist : undefined,
      preferredSubagents: allowlist,
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

  it.each([
    ['main', undefined, true], ['main', true, true], ['main', false, false],
    ['sub', undefined, false], ['sub', true, true], ['sub', false, false],
  ] as const)('resolves %s background=%s to detached=%s for spawn and resume', async (caller, background, detached) => {
    const callerId = caller === 'main' ? 'main' : 'agent-parent';
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    lifecycle.addHandle(callerId, 'agent');
    const context = createAgentToolContext(lifecycle, agentService(IAgentScopeContext, makeAgentScopeContext({
      agentId: callerId, parentAgentId: caller === 'main' ? undefined : 'main',
      agentScope: caller === 'main' ? '' : `agents/${callerId}`,
    })), sessionService(ISessionMetadata, sessionMetadataStub({
      'agent-child': { labels: { parentAgentId: callerId } },
    })));
    let operation = 0;
    for (const [resume, mode, expectedBackground] of [
      [undefined, background, detached],
      ['agent-child', !detached, !detached],
      ['agent-child', background, detached],
    ] as const) {
      const completion = deferred<{ readonly summary: string }>();
      lifecycle.run.mockImplementationOnce(async (agentId) => ({
        agentId, turn: {} as AgentRunHandle['turn'], completion: completion.promise,
      }));
      const args = { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model', background: mode, resume };
      const execution = await agentTool(context).resolveExecution(args);
      if (execution.isError === true) throw new Error('expected runnable execution');
      expect(execution).toMatchObject({ display: { kind: 'agent_call', background: expectedBackground } });
      expect(execution.description?.startsWith('Launching background')).toBe(expectedBackground);
      let returned = false;
      let returnedOutput: unknown;
      const pending = executeAgentToolRaw(context, args, signal, `call_agent_${operation++}`).then((result) => { returned = true; returnedOutput = result.output; return result; });
      const tasks = context.get(IAgentTaskService);
      await vi.waitFor(() => expect(tasks.list(false).filter((task) => task.status === 'running'), String(returnedOutput)).toHaveLength(1));
      const task = tasks.list(false).find((item) => item.status === 'running')!;
      expect(task.detached).toBe(expectedBackground);
      if (expectedBackground) {
        expect((await pending).output).toContain('automatic_notification: true');
      } else {
        expect(returned).toBe(false);
      }
      completion.resolve({ summary: 'inline result' });
      await tasks.wait(task.taskId);
      const result = await pending;
      if (!expectedBackground) expect(result.output).toContain('[summary]\ninline result');
      expect(lifecycle.publishedEvents).toContainEqual(expect.objectContaining({
        type: 'subagent.spawned', taskId: task.taskId, runInBackground: expectedBackground,
      }));
    }
  });

  it('keeps main omission background while a goal is active', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'], runCompletion: () => completion.promise });
    const context = createAgentToolContext(lifecycle);
    const goals = context.get(IAgentGoalService);
    await goals.createGoal({ objective: 'Inspect the fixture' });
    expect(goals.getGoal().goal?.status).toBe('active');
    const result = await executeAgentToolRaw(context, { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model' });
    expect(result.output).toContain('automatic_notification: true');
    const tasks = context.get(IAgentTaskService);
    const task = tasks.list(false)[0]!;
    expect(task).toMatchObject({ detached: true, status: 'running' });
    await goals.pauseGoal({});
    completion.resolve({ summary: 'goal dependency complete' });
    await tasks.wait(task.taskId);
  });

  it('rejects an omitted main background mode before launch when task tools are unavailable', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['AgentRun'] });
    const result = await executeAgentToolRaw(context, { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model' });
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('no foreground fallback was attempted');
    expect(result.output).toContain('background:false');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(context.get(IAgentTaskService).list(false)).toHaveLength(0);
  });

  it.each([false, true])('releases a main foreground wait on steer (already steered=%s), even with task tools disabled', async (alreadySteered) => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'], runCompletion: () => completion.promise });
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['AgentRun'] });
    const steer = new AbortController();
    const parent = new AbortController();
    if (alreadySteered) steer.abort(new Error('new input'));
    const pending = executeTool(agentTool(context), { turnId: 0, toolCallId: 'foreground',
      args: { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model', background: false },
      signal: parent.signal, steerSignal: steer.signal });
    const tasks = context.get(IAgentTaskService);
    await vi.waitFor(() => expect(tasks.list(false)).toHaveLength(1));
    if (!alreadySteered) steer.abort(new Error('new input'));
    const result = await pending;
    const task = tasks.list(false)[0]!;
    expect(result.output).toContain('New input ended this foreground wait');
    expect(task).toMatchObject({ detached: true, status: 'running' });
    parent.abort(userCancellationReason());
    expect(lifecycle.run.mock.calls[0]![2].signal.aborted).toBe(false);
    completion.resolve({ summary: 'still completed' });
    expect(await tasks.wait(task.taskId)).toMatchObject({ detached: true, status: 'completed' });
  });

  it('keeps a restricted subagent omission synchronous and does not detach its wait on steer', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'], runCompletion: () => completion.promise });
    lifecycle.addHandle('agent-parent', 'agent');
    const context = createAgentToolContext(lifecycle, agentService(IAgentScopeContext, makeAgentScopeContext({
      agentId: 'agent-parent', parentAgentId: 'main', agentScope: 'agents/agent-parent',
    })));
    context.get(IAgentProfileService).update({ activeToolNames: ['AgentRun'] });
    const steer = new AbortController();
    let returned = false;
    const pending = executeTool(agentTool(context), { turnId: 0, toolCallId: 'foreground',
      args: { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model' },
      signal, steerSignal: steer.signal }).then((result) => { returned = true; return result; });
    const tasks = context.get(IAgentTaskService);
    await vi.waitFor(() => expect(tasks.list(false)).toHaveLength(1));
    steer.abort(new Error('new input'));
    expect(returned).toBe(false);
    expect(tasks.list(false)[0]).toMatchObject({ detached: false, status: 'running' });
    completion.resolve({ summary: 'inline result' });
    expect((await pending).output).toContain('[summary]\ninline result');
  });

  it('removes the steer listener after foreground completion without detaching or duplicating delivery', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);
    const detach = vi.spyOn(tasks, 'detach');
    const steer = new AbortController();
    const result = await executeTool(agentTool(context), { turnId: 0, toolCallId: 'foreground',
      args: { prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model', background: false },
      signal, steerSignal: steer.signal });
    expect(result.output).toContain('[summary]\nchild result');
    steer.abort(new Error('late input'));
    expect(detach).not.toHaveBeenCalled();
    expect(result.output).toContain('status: completed');
    expect(context.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'task.notified')).toHaveLength(0);
  });

  it('processes send-now input while a detached foreground child continues and delivers its notification once', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'], runCompletion: () => completion.promise });
    lifecycle.addHandle('main', 'agent');
    const context = ctx = createTestAgent(
      sessionService(IAgentLifecycleService, lifecycle),
      sessionService(ISessionSubagentService, lifecycle),
      sessionService(ISessionCronService, cronStub),
    );
    context.mockNextResponse({ type: 'text', text: 'delegating' }, {
      type: 'function', id: 'foreground-call', name: 'AgentRun',
      arguments: JSON.stringify({ prompt: 'Inspect', description: 'Inspect fixture', model_alias: 'mock-model', background: false }),
    });
    context.mockNextResponse({ type: 'text', text: 'read correction' });
    await context.rpc.setPermission({ mode: 'auto' });
    const prompts = context.get(IAgentPromptService);
    const initial = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'delegate work' }], toolCalls: [], origin: { kind: 'user' } } });
    const tasks = context.get(IAgentTaskService);
    await vi.waitFor(() => expect(tasks.list(false), JSON.stringify(context.contextData())).toHaveLength(1));
    const task = tasks.list(false)[0]!;
    expect(task.detached).toBe(false);
    expect(JSON.stringify(context.llmCalls[0]!.history)).toContain('delegate work');
    const correction = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'new correction' }], toolCalls: [], origin: { kind: 'user' } } });
    expect(correction.state).toBe('pending');
    expect(tasks.getTask(task.taskId)?.detached).toBe(false);
    await prompts.steer([correction.id]);
    await vi.waitFor(() => expect(context.llmCalls).toHaveLength(2));
    expect(JSON.stringify(context.llmCalls[1]!.history)).toContain('new correction');
    expect(tasks.getTask(task.taskId)).toMatchObject({ detached: true, status: 'running' });
    expect(lifecycle.run.mock.calls[0]![2].signal.aborted).toBe(false);
    await initial.completion;
    await correction.completion;
    context.mockNextResponse({ type: 'text', text: 'integrated child result' });
    completion.resolve({ summary: 'child complete' });
    await vi.waitFor(() => expect(context.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'task.notified'), JSON.stringify({ task: tasks.getTask(task.taskId), events: context.allEvents.slice(-12) })).toHaveLength(1));
    await context.get(IAgentLoopService).settled();
    expect(JSON.stringify(context.contextData())).toContain('child complete');
    expect(context.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'task.notified')).toHaveLength(1);
  });

  it('keeps cheap targets recommended while accepting executable costly overrides', async () => {
    const lifecycle = createAgentLifecycleStub();
    const base = allowlistCatalog(['explore']);
    const cheap = normalizeAgentProfile({ name: 'explore', modelAlias: 'provider/fast', thinkingEffort: 'max',
      preferredModels: ['provider/fast', 'mock-model'], systemPrompt: () => '' });
    const catalog = { ...base, get: (name: string) => name === 'explore' ? cheap : base.get(name), list: () => [cheap] };
    const context = createAgentToolContext(lifecycle,
      { initialConfig: { models: POOL_MODEL_ENTRIES } }, sessionService(ISessionAgentProfileCatalog, catalog));
    expect(agentTool(context).description).toContain('Model aliases available across the targets above: mock-model, provider/fast, provider/smart');
    const overridden = await executeAgentTool(context, {
      prompt: 'Inspect the fixture', description: 'Inspect fixture', profile: 'explore', model_alias: 'provider/smart',
    });
    expect(overridden.isError).not.toBe(true);
    expect(typeof overridden.output).toBe('string');
    const advisoryLine = (overridden.output as string).split('\n').find((line) => line.startsWith('binding_advisories: '));
    expect(advisoryLine).toBeDefined();
    expect(JSON.parse(advisoryLine!.slice('binding_advisories: '.length))).toContainEqual(expect.objectContaining({
      code: 'model_not_preferred',
      ruleSource: 'profile:explore.preferred_models',
      requestedValue: 'provider/smart',
    }));
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
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'], true)),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Preset profile "coder" is blocked by allowed_subagents or deny_subagents');
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
      allowedSubagents: ['explore'],
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Preset profile "coder" is blocked by allowed_subagents or deny_subagents');
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

  it('passes typed roots to lifecycle while preserving the parent session cwd', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);
    const runtime = context.get(IAgentRuntimeService).inspect();
    const roots = runtime.path.separator === '\\'
      ? { workDir: 'C:\\kiki-agent-writer-root', additionalDirs: ['C:\\kiki-agent-material-root'] }
      : { workDir: '/kiki-agent-writer-root', additionalDirs: ['/kiki-agent-material-root'] };
    const parentCwd = context.get(ISessionWorkspaceContext).workDir;

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
      workDir: roots.workDir,
      additionalDirs: roots.additionalDirs,
    });

    expect(result.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoots: roots }));
    expect(context.get(ISessionWorkspaceContext).workDir).toBe(parentCwd);
  });

  it('inherits pinned roots when a nested AgentRun omits roots', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    lifecycle.addHandle('agent-parent', 'agent');
    const context = createAgentToolContext(
      lifecycle,
      agentService(IAgentScopeContext, makeAgentScopeContext({
        agentId: 'agent-parent', parentAgentId: 'main', agentScope: 'agents/agent-parent',
      })),
      agentService(IAgentWorkspaceRootsSeed, {
        _serviceBrand: undefined,
        roots: { workDir: '/kiki-agent-writer-root', additionalDirs: ['/kiki-agent-material-root'] },
      }),
    );
    Object.assign(context.get(IAgentRuntimeService), {
      workspaceRoots: () => ({ workDir: '/kiki-agent-writer-root', additionalDirs: ['/kiki-agent-material-root'] }),
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
    });

    expect(result.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenCalledWith(expect.objectContaining({
      delegator: { kind: 'agent', agentId: 'agent-parent' },
      workspaceRoots: { workDir: '/kiki-agent-writer-root', additionalDirs: ['/kiki-agent-material-root'] },
    }));
  });

  it('declares external roots as implicit external accesses for the permission gate', async () => {
    const context = createAgentToolContext();
    const runtime = context.get(IAgentRuntimeService).inspect();
    const args = {
      prompt: 'Investigate',
      description: 'Find cause',
      profile: 'explore',
      workDir: runtime.path.separator === '\\' ? 'C:\\kiki-agent-writer-root' : '/kiki-agent-writer-root',
      additionalDirs: [runtime.path.separator === '\\' ? 'C:\\kiki-agent-material-root' : '/kiki-agent-material-root'],
    };

    const execution = await agentTool(context).resolveExecution(args);
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual([
      {
        kind: 'file',
        operation: 'readwrite',
        path: args.workDir,
        recursive: true,
        implicitExternal: true,
      },
      {
        kind: 'file',
        operation: 'readwrite',
        path: args.additionalDirs[0],
        recursive: true,
        implicitExternal: true,
      },
    ]);

    const decision = await context.get(IAgentPermissionPolicyService).evaluate({
      turnId: 0,
      signal,
      toolCall: {
        type: 'function',
        id: 'call-agent-roots',
        name: 'AgentRun',
        arguments: JSON.stringify(args),
      },
      toolCalls: [],
      args,
      execution,
    } satisfies ResolvedToolExecutionHookContext);
    expect(decision).toMatchObject({
      policyName: 'external-link-access-ask',
      result: { kind: 'ask' },
    });
    context.get(IAgentPermissionModeService).setMode('yolo');
    await expect(context.get(IAgentPermissionPolicyService).evaluate({
      turnId: 0,
      signal,
      toolCall: {
        type: 'function',
        id: 'call-agent-roots-yolo',
        name: 'AgentRun',
        arguments: JSON.stringify(args),
      },
      toolCalls: [],
      args,
      execution,
    } satisfies ResolvedToolExecutionHookContext)).resolves.toMatchObject({
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
    });
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
    expect(execution.description).toBe('Launching background explore agent: Continue work');
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
    expect(execution.description).toBe('Launching background explore agent: Continue work');
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
    expect(execution.description).toBe('Launching background coder agent: Continue work');
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
          thinking: 'high',
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

  it('spawns a known non-thinking model-only AgentRun with off while rejecting explicit unsupported effort', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const catalog = modelCatalogResolving('mock-model', 'provider/smart');
    const declared = catalog.get('provider/smart');
    const context = createAgentToolContext(lifecycle,
      modelProviderServices({ ...catalog, get: (id) => id === 'provider/smart'
        ? { ...declared, capabilities: { ...declared.capabilities, thinking: false }, supportEfforts: [], defaultEffort: undefined }
        : catalog.get(id) }),
      { initialConfig: { models: POOL_MODEL_ENTRIES } });
    const implicit = await executeAgentToolRaw(context, { prompt: 'Investigate', description: 'Find cause', model_alias: 'provider/smart' });
    expect(implicit.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ model: 'provider/smart', thinking: 'off' }) }));
    const unsupported = await executeAgentToolRaw(context, { prompt: 'Investigate', description: 'Find cause', model_alias: 'provider/smart', effort: 'high' });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.output).toContain('not supported');
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
  });

  it('fails a model-only AgentRun before child creation when no default effort can be resolved', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const catalog = modelCatalogResolving('mock-model', 'provider/smart');
    const declared = catalog.get('provider/smart');
    const context = createAgentToolContext(lifecycle,
      modelProviderServices({ ...catalog, get: (id) => id === 'provider/smart' ? { ...declared, defaultEffort: undefined } : catalog.get(id) }),
      { initialConfig: { models: POOL_MODEL_ENTRIES } });
    const missing = await executeAgentToolRaw(context, { prompt: 'Investigate', description: 'Find cause', model_alias: 'provider/smart' });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('no resolvable default thinking effort');
    expect(lifecycle.create).not.toHaveBeenCalled();
    const explicit = await executeAgentToolRaw(context, { prompt: 'Investigate', description: 'Find cause', model_alias: 'provider/smart', effort: 'low' });
    expect(explicit.isError).not.toBe(true);
    expect(lifecycle.create).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ model: 'provider/smart', thinking: 'low' }) }));
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
    expect(result.output).toContain('both a concrete model_alias and effort');
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
      'agent-child': { type: 'sub', model: 'provider/example', labels: { workItem: 'example' } },
    };
    const registerAgent = vi.fn(async (agentId: string, meta: AgentMeta) => { agents[agentId] = meta; });
    const dispatch = vi.fn(async (_event: Event2) => {});
    const requester = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === ISessionMetadata) return { read: async () => ({ agents }),
            getAgentExecutor: async (agentId: string) => agents[agentId]?.executor, registerAgent,
            updateAgent: async (agentId: string, updater: (current: AgentMeta) => AgentMeta) => {
              const current = agents[agentId];
              if (current !== undefined) await registerAgent(agentId, updater(structuredClone(current)));
            } };
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
      type: 'sub', model: 'provider/example', labels: { workItem: 'example' },
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
      { kind: 'prompt', prompt: 'Continue', promptId: 'resume-prompt:resume:main:0:call_agent' },
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
      { kind: 'prompt', prompt: 'Continue', promptId: 'resume-prompt:resume:main:0:call_agent' },
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
      data: () => ({ profileName: 'explore', modelAlias: 'stale-model', thinkingLevel: 'medium' }),
      prepareResumeBinding: vi.fn(async () => prepareFixtureResumeBinding({ modelAlias: 'stale-model', thinkingLevel: 'medium' })),
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
      { kind: 'prompt', prompt: 'Continue', promptId: 'resume-prompt:resume:main:0:call_agent' },
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
      prepareResumeBinding: vi.fn(async () => prepareFixtureResumeBinding(profileData)),
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
      { kind: 'prompt', prompt: 'Continue', promptId: 'resume-prompt:resume:main:0:call_agent' },
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
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled. Main defaults to background when background is omitted; no foreground fallback was attempted. Enable those tools, or retry with background:false for a genuine synchronous dependency.',
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
    expect(result.output).toMatch(/^actual_model: \S+$/m);
    expect(result.output).toContain('status: running');
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('parent_notify: enabled');
    expect(result.output).not.toContain('next_step:');
    expect(result.output).not.toContain('resume_hint:');
    expect(result.output.split('\n')).toHaveLength(8);
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
      const first = await ctx.untilToolCall({ content: 'moon-result', output: 'moon-result' }) as EventSnapshotEntry[];
      const isToolCallWire = (entry: EventSnapshotEntry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event'
        && (entry.args as { event?: { type?: string } }).event?.type === 'tool.call';
      const wireCall = first.find(isToolCallWire);
      const snapshot = createEventSnapshotter();
      const stableEvents = (entries: readonly EventSnapshotEntry[]) => snapshot(entries.filter((entry) => entry.type !== '[wire]' || (entry.event !== 'llm.tools_snapshot' && entry.event !== 'llm.request')));
      expect(stableEvents(first.filter((entry) => !isToolCallWire(entry)))).toMatchInlineSnapshot(`
        [wire] plugin.session_start        { "content": null, "time": "<time>" }
        [wire] permission.set_mode         { "mode": "auto", "source": "runtime", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "permission": "auto" }
        [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
        [wire] prompt.accepted             { "promptId": "<msg-1>", "time": "<time>" }
        [emit] prompt.enqueued             { "time": "<time>", "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "retryStatus": "running" }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
        [wire] prompt.enqueued             { "schemaVersion": 1, "promptId": "<msg-1>", "userMessageId": "<msg-1>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "retryStatus": "running", "time": "<time>" }
        [wire] prompt.launch_committed     { "launchId": "<uuid-1>", "promptId": "<msg-1>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
        [wire] turn.prompt                 { "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "turnId": 0, "promptId": "<msg-1>", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "managed": true }
        [emit] turn.started                { "time": "<time>", "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up moon", "promptId": "<msg-1>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced             { "time": "<time>", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>", "source": { "turnId": 0, "stepId": "<uuid-2>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-1>", "messageId": "<msg-1>", "turnId": 0, "stepId": "<uuid-2>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [emit] context.append_message      { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" } }
        [emit] context.spliced             { "time": "<time>", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" }, "delivery": { "deliveryId": "<dlv-2>", "messageId": "<msg-2>", "deliveredAt": "<time>", "origin": "injection" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "partId": "<uuid-3>", "delta": "I will look it up." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 3, "tokens": 212, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 212 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." }, "responseInstanceId": "<uuid-4>" } }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "part": { "type": "text", "text": "I will look it up." }, "responseInstanceId": "<uuid-4>" }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.call", "uuid": "<uuid-5>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } } }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      const firstInput = ctx.lastLlmInput();
      expect(firstInput.input.tools.filter((tool) => tool.name === 'Lookup')).toHaveLength(1);
      expect({ ...firstInput, input: { ...firstInput.input, tools: firstInput.input.tools.filter((tool) => tool.name === 'Lookup') } }).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Lookup
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      const second = await ctx.untilTurnEnd() as EventSnapshotEntry[];
      const canonicalWireCall = wireCall ?? second.find(isToolCallWire);
      expect(canonicalWireCall).toBeDefined();
      expect(ctx.allEvents.filter(isToolCallWire)).toHaveLength(1);
      expect(stableEvents([canonicalWireCall!, ...second.filter((entry) => !isToolCallWire(entry))])).toMatchInlineSnapshot(`
        [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-5>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [emit] tool.result                 { "time": "<time>", "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "tool.result", "parentUuid": "<uuid-5>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } } }
        [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-5>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 1, "stepId": "<uuid-2>", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 196, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-6>" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "0", "step": 2 } }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-6>", "partId": "<uuid-7>", "delta": "The lookup result is moon-result." }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 0, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 412, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "length": 5, "tokens": 228, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "contextTokens": 228 }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "The lookup result is moon-result." }, "responseInstanceId": "<uuid-8>" } }
        [emit] context.append_loop_event   { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed         { "time": "<time>", "turnId": 0, "step": 2, "stepId": "<uuid-6>", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "The lookup result is moon-result." }, "responseInstanceId": "<uuid-8>" }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 216, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
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

      expect(stableEvents(await ctx.untilTurnEnd() as EventSnapshotEntry[])).toMatchInlineSnapshot(`
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "lastTurn": { "turnId": 0, "reason": "completed", "at": "<time>" }, "background": [] }
        [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
        [emit] prompt.completed             { "time": "<time>", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
        [emit] prompt.outcome_committed     { "time": "<time>", "terminal": { "promptId": "<msg-1>", "turnId": 0, "state": "completed", "result": { "type": "completed", "steps": 2, "truncated": false } } }
        [wire] prompt.completed             { "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
        [wire] prompt.outcome_committed     { "terminal": { "promptId": "<msg-1>", "turnId": 0, "state": "completed", "result": { "type": "completed", "steps": 2, "truncated": false } }, "time": "<time>" }
        [emit] prompt.enqueued              { "time": "<time>", "schemaVersion": 1, "promptId": "<msg-3>", "userMessageId": "<msg-3>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "retryStatus": "running" }
        [emit] prompt.submitted             { "time": "<time>", "agentId": "main", "promptId": "<msg-3>", "userMessageId": "<msg-3>", "status": "running", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "createdAt": "<time>", "appendTiming": "agent_idle", "revision": 0 }
        [wire] prompt.accepted              { "promptId": "<msg-3>", "time": "<time>" }
        [wire] prompt.enqueued              { "schemaVersion": 1, "promptId": "<msg-3>", "userMessageId": "<msg-3>", "createdAt": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>" }, "alreadyMaterialized": false, "appendTiming": "agent_idle", "revision": 0, "queueIndex": 0, "retryStatus": "running", "time": "<time>" }
        [wire] prompt.launch_committed      { "launchId": "<uuid-9>", "promptId": "<msg-3>", "revision": 0, "committedAt": "<time>", "time": "<time>" }
        [wire] turn.prompt                  { "turnId": 1, "promptId": "<msg-3>", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "managed": true, "time": "<time>" }
        [emit] turn.prompt                  { "time": "<time>", "turnId": 1, "promptId": "<msg-3>", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "managed": true }
        [emit] turn.started                 { "time": "<time>", "turnId": 1, "origin": { "kind": "user" }, "prompt": "Can you still use Lookup?", "promptId": "<msg-3>" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] prompt.started               { "time": "<time>", "agentId": "main", "promptId": "<msg-3>" }
        [emit] context.append_message       { "time": "<time>", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-10>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-10>", "step": 1, "deliveredAt": "<time>", "origin": "user" } }
        [emit] context.spliced              { "time": "<time>", "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-10>", "step": 1 } } ] }
        [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-3>", "source": { "turnId": 1, "stepId": "<uuid-10>", "step": 1 } }, "delivery": { "deliveryId": "<dlv-3>", "messageId": "<msg-3>", "turnId": 1, "stepId": "<uuid-10>", "step": 1, "deliveredAt": "<time>", "origin": "user" }, "time": "<time>" }
        [emit] turn.step.started            { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-10>" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.begin", "uuid": "<uuid-10>", "turnId": "1", "step": 1 } }
        [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-10>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta              { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-10>", "partId": "<uuid-11>", "delta": "No lookup tool is available." }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "turnId": 1, "agentId": "main", "provider": "test-provider", "modelAlias": "mock-model", "executorId": "native", "usageKnown": true, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "usage": { "byModel": { "mock-model": { "inputOther": 648, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 648, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured      { "length": 7, "tokens": 246, "time": "<time>" }
        [emit] agent.status.updated         { "time": "<time>", "contextTokens": 246 }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "content.part", "uuid": "<uuid-11>", "turnId": "1", "step": 1, "stepUuid": "<uuid-10>", "part": { "type": "text", "text": "No lookup tool is available." }, "responseInstanceId": "<uuid-12>" } }
        [emit] context.append_loop_event    { "time": "<time>", "event": { "type": "step.end", "uuid": "<uuid-10>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" } }
        [emit] turn.step.completed          { "time": "<time>", "turnId": 1, "step": 1, "stepId": "<uuid-10>", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated       { "time": "<time>", "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-11>", "turnId": "1", "step": 1, "stepUuid": "<uuid-10>", "part": { "type": "text", "text": "No lookup tool is available." }, "responseInstanceId": "<uuid-12>" }, "time": "<time>" }
        [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-10>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 236, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] turn.ended                   { "turnId": 1, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                   { "time": "<time>", "turnId": 1, "reason": "completed" }
      `);
      const finalInput = ctx.lastLlmInput();
      expect(finalInput.input.tools.some((tool) => tool.name === 'Lookup')).toBe(false);
      expect({ ...finalInput, input: { ...finalInput.input, tools: [] } }).toMatchInlineSnapshot(`
        tools: []
        messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
      `);
      const tools = ctx.allEvents.filter((entry) => entry.type === '[wire]' && entry.event === 'llm.tools_snapshot')
        .map((entry) => entry.args as { hash: string; tools: readonly { name: string; description: string; parameters: unknown }[] });
      const requests = ctx.allEvents.filter((entry) => entry.type === '[wire]' && entry.event === 'llm.request')
        .map((entry) => entry.args as { toolsHash: string });
      expect(tools).toHaveLength(2);
      expect(tools[0]?.tools.find((tool) => tool.name === 'Lookup')).toMatchObject({
        description: 'Look up a short test value.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      });
      expect(tools[1]?.tools.some((tool) => tool.name === 'Lookup')).toBe(false);
      expect(requests.map((request) => request.toolsHash)).toEqual([tools[0]?.hash, tools[0]?.hash, tools[1]?.hash]);
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
      background: false,
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
