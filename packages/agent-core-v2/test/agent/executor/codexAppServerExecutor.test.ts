import { PassThrough, Writable } from 'node:stream';
import { DispatchCapacity } from '#/session/dispatch/capacity';
import {
  CodexAppServerClient,
  type HostProcessLike,
  CodexClientError,
  CodexRemoteError,
  type CodexServerRequestHandler,
  type CodexTurnCompletion,
  type CodexTurnHandle,
  type NormalizedExecutorEvent,
} from '@kiki/codex-client';
import { describe, expect, it, vi } from 'vitest';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { coldPromptFixture } from './coldPromptFixture';
import { resolveExecutionBinding } from '#/agent/profile/executionBinding';
import { attachExternalMailboxHarness } from './mailboxHarness';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { appendSharedPromptField } from '#/app/promptField/builtinPromptFields';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { CodexAppServerExecutorSession } from '#/agent/execution/codexAppServerExecutorSession';
import {
  ExecutorRuntimeUpdate,
  ExecutorSessionUpdated,
  ExecutorTurnMetadata,
  externalExecutorKey,
} from '#/agent/execution/externalExecutorOps';
import { TurnPrompt, turnKey } from '#/agent/loop/turnOps';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { agentMessageMaterializationsKey } from '#/session/agentCollaboration/messageReceiptState';
import { IAgentUsageService } from '#/agent/usage/usage';
import {
  agentExecutorBindingFingerprint,
  IAgentExecutorRegistry,
  type AgentExecutorContext,
} from '#/app/agentExecutor/agentExecutor';
import type { Event2 } from '#/app/event/event2';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionQuestionService } from '#/session/question/question';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHarnessMcpService } from '#/app/agentExecutor/harnessMcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

interface HarnessOptions {
  readonly models?: readonly string[];
  readonly actualModel?: string;
  readonly modelProvider?: string;
  readonly agentVersion?: string;
  readonly modelReasoningEfforts?: readonly string[];
  readonly modelListBehavior?: 'fail' | 'hang';
  readonly modelAlias?: string;
  readonly unpinModel?: boolean;
  readonly thinkingEffort?: string;
  readonly priorThreadId?: string;
  readonly localSource?: boolean;
  readonly priorBindingFingerprint?: string;
  readonly resumeError?: unknown;
  readonly approvalOptionId?: string;
  readonly history?: readonly ContextMessage[];
  readonly serverRequest?: {
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  };
  readonly turnEvents?: readonly NormalizedExecutorEvent[];
  readonly questionAnswer?: string;
  readonly questionAnswers?: Readonly<Record<string, string>>;
  readonly deferTurnCompletion?: boolean;
  readonly steerResponse?: unknown;
  readonly permissionMode?: { mode: 'manual' | 'auto' | 'yolo' };
  readonly kikiSubagents?: boolean;
  readonly clientFactory?: ConstructorParameters<typeof CodexAppServerExecutorSession>[1];
}

function createHarness(options: HarnessOptions = {}) {
  const events: Event2[] = [];
  const starts: Readonly<Record<string, unknown>>[] = [];
  const modelLists: string[][] = [];
  const resumes: Readonly<Record<string, unknown>>[] = [];
  const prompts: Readonly<Record<string, unknown>>[] = [];
  const serverResults: unknown[] = [];
  const stateValues = new Map<unknown, unknown>([
    [turnKey, { nextTurnId: 2, cancelledTurnIds: [] }],
    [agentMessageMaterializationsKey, agentMessageMaterializationsKey.initial()],
    [externalExecutorKey, options.priorThreadId === undefined ? {} : {
      executorId: 'codex-app-server',
      descriptorRevision: 'r1',
      sessionRef: {
        executorId: 'codex-app-server',
        version: 1,
        ref: { threadId: options.priorThreadId, localSource: options.localSource === true ? {
          localId: 'external:codex:source', executorId: 'codex-app-server', externalId: options.priorThreadId,
          home: '/vendor', engine: 'codex',
        } : undefined },
      },
      sessionEpoch: 1,
      profileDeliveredSessionId: options.priorThreadId,
    }],
  ]);
  const states = {
    _serviceBrand: undefined,
    contributeState: () => ({ dispose: () => {} }),
    get: (key: unknown) => stateValues.get(key),
    set: (key: unknown, value: unknown) => stateValues.set(key, value),
  } as unknown as IAgentStateService;
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: async (event: Event2) => {
      events.push(event);
      if (event instanceof TurnPrompt) {
        stateValues.set(turnKey, { nextTurnId: event.turnId! + 1, cancelledTurnIds: [] });
      }
      if (event instanceof ExecutorSessionUpdated) {
        stateValues.set(externalExecutorKey, {
          executionGeneration: event.executionGeneration,
          executorId: event.executorId,
          descriptorRevision: event.descriptorRevision,
          bindingFingerprint: event.bindingFingerprint,
          sessionRef: event.sessionRef,
          sessionEpoch: event.sessionEpoch,
          profileDeliveredSessionId: event.profileDeliveredSessionId,
        });
      }
    },
  } as unknown as IEventDispatcher;
  const loopEvents: unknown[] = [];
  const memory = {
    _serviceBrand: undefined,
    get: () => options.history ?? [],
    append: () => {},
    appendObservable: () => {},
    appendLoopEvent: (event: unknown) => { loopEvents.push(event); },
  } as unknown as IAgentContextMemoryService;
  const pendingTurns = new Set<number>();
  const interaction = {
    _serviceBrand: undefined,
    cancelPendingForTurn: vi.fn((turnId: number) => {
      pendingTurns.delete(turnId);
    }),
  } as unknown as ISessionInteractionService;
  const approval = {
    _serviceBrand: undefined,
    request: async () => ({
      decision: 'approved' as const,
      selectedOptionId: options.approvalOptionId,
    }),
  } as unknown as ISessionApprovalService;
  const questionRequest = vi.fn(async () =>
    options.questionAnswers ?? (options.questionAnswer === undefined ? null : { '0': options.questionAnswer }));
  const question = {
    _serviceBrand: undefined,
    request: questionRequest,
  } as unknown as ISessionQuestionService;
  const runtimeLease = {
    runtime: {
      process: { spawn: vi.fn() },
      workspace: {
        mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots,
      },
    },
    dispose: vi.fn(),
  };
  const runtime = {
    _serviceBrand: undefined,
    acquire: () => runtimeLease,
  } as unknown as IAgentRuntimeService;
  const workspace = {
    _serviceBrand: undefined,
    workDir: 'C:/workspace',
    additionalDirs: ['C:/shared'],
  } as unknown as ISessionWorkspaceContext;
  const wire = {
    _serviceBrand: undefined,
    flush: async () => {},
  } as unknown as IWireService;
  const usageRecords: Parameters<IAgentUsageService['record']>[] = [];
  const usage = {
    _serviceBrand: undefined,
    record: (...args: Parameters<IAgentUsageService['record']>) => { usageRecords.push(args); },
    status: () => ({}),
    onDidRecord: () => ({ dispose: () => {} }),
  } as IAgentUsageService;
  const modelCatalog = {
    get: () => ({ providerName: 'openai' }) as Model,
  } as unknown as IModelCatalog;
  const metadataUpdates: AgentMeta[] = [];
  const metadata = {
    read: async () => ({ agents: {} }),
    registerAgent: vi.fn(),
    updateAgent: vi.fn(async (_agentId: string, updater: (current: AgentMeta) => AgentMeta) => {
      metadataUpdates.push(updater({ negotiated: { models: ['stale-model'], image: true } }));
    }),
  } as unknown as ISessionMetadata;
  const negotiatedRegistry = vi.fn();
  const services = new Map<unknown, unknown>([
    [IAgentStateService, states],
    [IAgentPermissionModeService, options.permissionMode ?? { mode: 'manual' }],
    [IBootstrapService, { platform: 'linux' }],
    [ISessionContext, { sessionId: 'session-1' }],
    [IHarnessMcpService, { acquire: async () => ({ dispose: vi.fn(), server: {
      name: 'kiki-harness', command: 'kiki', args: ['mcp', '--attached'], env: [{ name: 'KIKI_DELEGATION_TOKEN', value: 'fixture-token' }] } }) }],
    [IModelCatalog, modelCatalog],
    [IAgentUsageService, usage],
    [IEventDispatcher, dispatcher],
    [IAgentContextMemoryService, memory],
    [ISessionInteractionService, interaction],
    [ISessionApprovalService, approval],
    [ISessionQuestionService, question],
    [IAgentRuntimeService, runtime],
    [ISessionWorkspaceContext, workspace],
    [IWireService, wire],
    [IAgentExecutorRegistry, { recordNegotiated: negotiatedRegistry }],
    [ISessionMetadata, metadata],
  ]);
  const context: AgentExecutorContext = {
    agent: {
      id: options.kikiSubagents === true ? 'main' : 'codex-agent',
      accessor: { get: (id) => services.get(id) as never },
    },
    descriptor: {
      id: 'codex-app-server',
      protocol: 'codex-app-server',
      command: 'codex',
      args: [],
      permission: { via: 'turn_param', manual: 'on-request', auto: 'on-request', yolo: 'never' },
      revision: 'r1',
    },
    binding: {
      modelAlias: options.unpinModel === true ? undefined : options.modelAlias ?? 'gpt-test',
      thinkingLevel: options.thinkingEffort ?? 'high',
      systemPrompt: 'Frozen profile instructions',
      executorId: 'codex-app-server',
      executorProtocol: 'codex-app-server',
      executorDescriptorRevision: 'r1',
      allowKikiSubagents: options.kikiSubagents,
    },
  };
  const priorState = stateValues.get(externalExecutorKey) as Record<string, unknown>;
  if (priorState['sessionRef'] !== undefined) {
    stateValues.set(externalExecutorKey, {
      ...priorState,
      bindingFingerprint:
        options.priorBindingFingerprint ?? agentExecutorBindingFingerprint(context.binding),
    });
  }
  let serverHandler: CodexServerRequestHandler | undefined;
  let resolveTurnCompletion: ((result: CodexTurnCompletion) => void) | undefined;
  const turnCancel = vi.fn(async () => {
    resolveTurnCompletion?.({
      threadId: 'thread-new',
      turnId: 'turn-1',
      status: 'interrupted',
      stderrTail: '',
    });
    return true;
  });
  const client = {
    status: () => resolveTurnCompletion === undefined
      ? { state: 'ready' as const, agentVersion: options.agentVersion }
      : { state: 'turning' as const, threadId: 'thread-new', turnId: 'turn-1', agentVersion: options.agentVersion },
    request: vi.fn(async (_method: string, _params: unknown) => options.steerResponse ?? { turnId: 'turn-1' }),
    connect: async () => {},
    listModels: vi.fn(async () => {
      if (options.modelListBehavior === 'hang') return new Promise<never>(() => {});
      if (options.modelListBehavior === 'fail') throw new Error('model catalog unavailable');
      const models = [...(options.models ?? [options.modelAlias ?? 'gpt-test'])];
      modelLists.push(models);
      return {
        data: models.map((id) => ({
          id,
          supportedReasoningEfforts: options.modelReasoningEfforts?.map((reasoningEffort) => ({
            reasoningEffort,
          })),
        })),
        nextCursor: null,
      };
    }),
    startThread: async (params: Readonly<Record<string, unknown>>) => {
      starts.push(params);
      return { thread: { id: 'thread-new' }, model: options.actualModel, modelProvider: options.modelProvider };
    },
    resumeThread: async (params: Readonly<Record<string, unknown>>) => {
      resumes.push(params);
      if (options.resumeError !== undefined) {
        throw options.resumeError instanceof Error
          ? options.resumeError
          : new Error('Configured resume failure');
      }
      return {
        thread: { id: String(params['threadId']) },
        model: options.actualModel,
        modelProvider: options.modelProvider,
      };
    },
    startTurn: async (
      params: Readonly<Record<string, unknown>>,
      _signal: AbortSignal,
      onEvent: (event: NormalizedExecutorEvent) => void | Promise<void>,
    ): Promise<CodexTurnHandle> => {
      prompts.push(params);
      if (serverHandler !== undefined && options.approvalOptionId !== undefined) {
        await serverHandler(
          {
            id: 41,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: String(params['threadId']),
              turnId: 'turn-1',
              itemId: 'command-1',
              startedAtMs: 1,
              command: 'curl example.test',
              availableDecisions: [
                'decline',
                { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } },
              ],
            },
          },
          {
            respond: async (result) => { serverResults.push(result); },
            respondError: async (code, message) => { serverResults.push({ error: { code, message } }); },
          },
          new AbortController().signal,
        );
      }
      if (serverHandler !== undefined && options.serverRequest !== undefined) {
        await serverHandler(
          { id: 42, ...options.serverRequest },
          {
            respond: async (result) => { serverResults.push(result); },
            respondError: async (code, message) => { serverResults.push({ error: { code, message } }); },
          },
          new AbortController().signal,
        );
      }
      const completed: CodexTurnCompletion = {
        threadId: String(params['threadId']),
        turnId: 'turn-1',
        status: 'completed',
        stderrTail: '',
        usage: { inputTokens: 4, cachedInputTokens: 1, outputTokens: 2 },
      };
      const completion = options.deferTurnCompletion === true
        ? new Promise<CodexTurnCompletion>((resolve) => { resolveTurnCompletion = resolve; })
        : Promise.resolve(completed);
      for (const event of options.turnEvents ?? [
        {
          type: 'message.delta',
          role: 'assistant',
          messageId: 'message-1',
          content: { type: 'text', text: 'done' },
        },
      ]) await onEvent(event);
      return { completion, cancel: turnCancel };
    },
    shutdown: vi.fn(async () => {}),
  };
  const spawns: (readonly string[])[] = [];
  const createSession = (executorContext: AgentExecutorContext) => new CodexAppServerExecutorSession(
    executorContext,
    (processes, handler) => {
      if (options.clientFactory !== undefined) return options.clientFactory(processes, handler);
      serverHandler = handler;
      let state: 'cold' | 'ready' = 'cold';
      return {
        ...client,
        status: () => state === 'cold' ? { state: 'cold' as const } : client.status(),
        connect: async () => {
          if (state === 'ready') return;
          await processes.spawn('codex', ['app-server'], {}).catch(() => undefined);
          state = 'ready';
        },
      };
    },
  );
  runtimeLease.runtime.process.spawn.mockImplementation(async (_command: string, args: readonly string[]) => {
    spawns.push(args);
    throw new Error('fixture-spawn');
  });
  let session: CodexAppServerExecutorSession | undefined;
  const getSession = (): CodexAppServerExecutorSession => session ??= createSession(context);
  return {
    get session(): CodexAppServerExecutorSession {
      return getSession();
    },
    createSession,
    context,
    states,
    client,
    events,
    starts,
    modelLists,
    resumes,
    prompts,
    serverResults,
    interaction,
    pendingTurns,
    questionRequest,
    question,
    runtime,
    runtimeLease,
    workspace,
    wire,
    usage,
    modelCatalog,
    memory,
    loopEvents,
    spawns,
    approval,
    dispatcher,
    usageRecords,
    turnCancel,
    metadataUpdates,
    negotiatedRegistry,
  };
}

function createExecutionHarness(options: HarnessOptions = {}) {
  const harness = createHarness({ ...options, deferTurnCompletion: true });
  const ix = new TestInstantiationService();
  const agentId = harness.context.agent.id;
  const capacity = new DispatchCapacity();
  ix.stub(ISessionDispatchService, { reserveExecution: (id) => capacity.reserve('main', {
    maxDirectChildren: 1, maxTotalSubagents: 1,
  }, id) });
  ix.set(IAgentContextMemoryService, harness.memory);
  ix.stub(IAgentContextInjectorService, { reconcileAllAtSafeBoundary: async () => {} });
  ix.stub(ISessionTodoService, { getTodos: () => [], getNotes: () => ({}) });
  ix.stub(IAgentGoalService, { getGoal: () => ({ goal: null }) });
  ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
  ix.set(IAgentExecutorRegistry, {
    resolveExecutable: async () => ({
      descriptor: harness.context.descriptor,
      options: {},
      provider: { create: harness.createSession },
    }),
  } as unknown as IAgentExecutorRegistry);
  ix.stub(ISessionMetadata, { read: async () => ({ id: 's1', createdAt: 1, updatedAt: 1, archived: false, agents: {} }), registerAgent: vi.fn(), updateAgent: vi.fn(async () => {}) });
  ix.set(IAgentProfileService, {
    _serviceBrand: undefined,
    data: () => harness.context.binding,
    preparePromptConfiguration: async () => false,
    getSystemPrompt: () => appendSharedPromptField(harness.context.binding.systemPrompt, { values: { 'system.shared': 'ALL_EXECUTORS_SHARED' }, fields: [] }),
  } as unknown as IAgentProfileService);
  ix.set(IAgentRuntimeService, harness.runtime);
  ix.set(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId,
    scope: (subKey) => subKey === undefined ? agentId : `${agentId}/${subKey}`,
  });
  ix.set(IAgentStateService, harness.states);
  ix.set(IAgentPermissionModeService, { mode: 'manual' } as IAgentPermissionModeService);
  ix.set(IAgentUsageService, harness.usage);
  ix.set(IEventDispatcher, harness.dispatcher);
  ix.set(IModelCatalog, harness.modelCatalog);
  ix.set(IWireService, harness.wire);
  ix.set(ISessionApprovalService, harness.approval);
  ix.set(ISessionInteractionService, harness.interaction);
  ix.set(ISessionQuestionService, harness.question);
  ix.set(ISessionWorkspaceContext, harness.workspace);
  ix.provide(IAgentLoopService, {} as IAgentLoopService);
  ix.stub(IAgentPromptService, {});
  const execution = ix.get(IAgentExecutionService) as AgentExecutionService;
  return {
    ix,
    execution,
    capacity,
    starts: harness.starts,
    prompts: harness.prompts,
    pendingTurns: harness.pendingTurns,
    interaction: harness.interaction,
    client: harness.client,
    runtimeLease: harness.runtimeLease,
    turnCancel: harness.turnCancel,
  };
}

describe('Codex app-server external executor', () => {
  it('sends only explicitly selected Codex controls without injecting sandbox or developer instructions', async () => {
    const harness = createHarness({ modelReasoningEfforts: ['high'] });
    const execution = resolveExecutionBinding({ executor: 'codex-app-server', overrides: {
      model: 'gpt-test', thinking: 'high', permission_mode: 'auto',
    } }, undefined, undefined, undefined);
    const session = harness.createSession({ ...harness.context, binding: {
      ...harness.context.binding, execution, systemPrompt: '', kikiContext: [], allowKikiSubagents: false,
    } });
    try {
      const handle = await session.run({ kind: 'prompt', prompt: 'ONLY_USER' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(JSON.parse(JSON.stringify(harness.starts[0]))).toEqual({ cwd: 'C:/workspace', model: 'gpt-test', approvalPolicy: 'on-request' });
      expect(JSON.parse(JSON.stringify(harness.prompts[0]))).toEqual({ threadId: 'thread-new', model: 'gpt-test', effort: 'high', approvalPolicy: 'on-request', input: [{ type: 'text', text: 'ONLY_USER' }] });
    } finally { await session.shutdown(); }
  });
  it('starts a bare new Codex thread at a generation boundary and reuses it after cold restore', async () => {
    const harness = createHarness({ priorThreadId: 'old-thread', unpinModel: true, thinkingEffort: 'off',
      history: [{ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'OLD_KIKI_HISTORY' }] }] });
    const execution = resolveExecutionBinding({ executor: 'codex-app-server' }, undefined, undefined, undefined);
    const context = { ...harness.context, binding: { ...harness.context.binding, execution,
      modelAlias: undefined, thinkingLevel: 'off', systemPrompt: '', kikiContext: [], allowKikiSubagents: false } };
    const session = harness.createSession(context);
    try {
      const handle = await session.run({ kind: 'prompt', prompt: 'ONLY_NEW_USER' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.resumes).toEqual([]);
      expect(JSON.parse(JSON.stringify(harness.starts[0]))).toEqual({ cwd: 'C:/workspace' });
      expect(JSON.parse(JSON.stringify(harness.prompts[0]))).toEqual({ threadId: 'thread-new', input: [{ type: 'text', text: 'ONLY_NEW_USER' }] });
      expect(harness.states.get(externalExecutorKey)).toMatchObject({ executionGeneration: 1, sessionEpoch: 2 });
      await session.shutdown();
      const cold = harness.createSession(context);
      try {
        const next = await cold.run({ kind: 'prompt', prompt: 'COLD_USER' }, { signal: new AbortController().signal });
        await next.completion;
        expect(harness.resumes[0]).toMatchObject({ threadId: 'thread-new' });
        expect(harness.starts).toHaveLength(1);
      } finally { await cold.shutdown(); }
    } finally { await session.shutdown(); }
  });
  it('delivers a text steer into the active remote turn and rejects stale acknowledgments', async () => {
    const harness = createHarness({ deferTurnCompletion: true });
    await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    const message: ContextMessage = {
      role: 'user', content: [{ type: 'text', text: 'adjust course' }], toolCalls: [],
    };
    expect(await harness.session.steer(message)).toBe(true);
    expect(harness.client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-new', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'adjust course' }],
    }, expect.any(AbortSignal));
    expect(await harness.session.steer({ ...message, content: [{ type: 'image_url', imageUrl: { url: 'https://example.test/image.png' } }] })).toBe(false);
    await harness.session.shutdown();

    const stale = createHarness({ deferTurnCompletion: true, steerResponse: { turnId: 'earlier-turn' } });
    await stale.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    expect(await stale.session.steer(message)).toBe(false);
    await stale.session.shutdown();
  });

  it('validates the exact model, maps the native thread and turn settings, and records output', async () => {
    const harness = createHarness();
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );

    await expect(handle.completion).resolves.toMatchObject({ summary: 'done' });
    expect(harness.starts[0]).toMatchObject({
      model: 'gpt-test',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: 'Frozen profile instructions',
    });
    expect(harness.prompts[0]).toMatchObject({
      effort: 'high',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    expect(harness.events.find((event) => event instanceof ExecutorTurnMetadata)).toMatchObject({
      protocol: 'codex-app-server',
      profileDelivery: 'developer_instructions',
      losses: ['codex_no_step_boundaries'],
    });
    expect(harness.usageRecords).toEqual([[
      'gpt-test',
      { inputOther: 3, inputCacheRead: 1, inputCacheCreation: 0, output: 2 },
      { type: 'turn', turnId: 2, step: 1 },
      {
        provider: 'openai',
        modelAlias: 'gpt-test',
        executorId: 'codex-app-server',
      },
    ]]);
    await harness.session.shutdown();
  });

  it('records Codex app-server actual model metadata without changing the binding', async () => {
    const harness = createHarness({ actualModel: 'gpt-5-codex', modelProvider: 'openai-codex' });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    const runtime = harness.events.filter((event) => event instanceof ExecutorRuntimeUpdate);
    expect(runtime).toContainEqual(expect.objectContaining({
      kind: 'session',
      value: {
        meta: {
          source: 'codex-app-server',
          actualModel: 'gpt-5-codex',
          modelProvider: 'openai-codex',
        },
      },
    }));
    expect(harness.context.binding.modelAlias).toBe('gpt-test');
    await harness.session.shutdown();
  });

  it('forwards queued collaboration mail through the next ordinary Codex resume before acknowledging it', async () => {
    const harness = createExecutionHarness();
    const mailbox = attachExternalMailboxHarness(harness.ix, 'codex-agent');
    try {
      await expect(mailbox.messaging.send({
        sourceAgentId: 'main',
        sourceTaskName: 'root',
        targetAgentId: 'codex-agent',
        targetTaskName: 'codex-agent',
        content: 'queued Codex mail',
        idempotencyKey: 'queued-codex-mail',
        waitForRunningDelivery: true,
      })).resolves.toMatchObject({ delivery: 'queued' });

      await harness.execution.run(
        { kind: 'prompt', prompt: 'ordinary Codex resume' },
        { signal: new AbortController().signal },
      );

      const input = JSON.stringify(harness.prompts[0]?.['input']);
      expect(input).toContain('Message from agent \\"root\\" (main):\\n\\nqueued Codex mail');
      expect(input).toContain('ordinary Codex resume');
      expect(mailbox.delivered()).toBe(true);
    } finally {
      await mailbox.dispose();
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('runs an idle Codex executor from a mailbox message with its collaboration origin', async () => {
    const harness = createHarness();
    const prompt = 'Message from agent "root" (main):\n\ncontinue';
    const message: ContextMessage = {
      id: 'mailbox-message',
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      toolCalls: [],
      origin: {
        kind: 'agent_message',
        messageId: 'mailbox-message',
        senderAgentId: 'main',
        senderTaskName: 'root',
      },
    };

    const handle = await harness.session.run(
      { kind: 'mailbox', prompt, message },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.prompts[0]?.['input']).toEqual([{ type: 'text', text: prompt }]);
    expect(harness.events.find((event) => event instanceof TurnPrompt)).toMatchObject({
      origin: message.origin,
    });
    await harness.session.shutdown();
  });

  it('records only the connected Codex version and clears stale negotiated capability facts', async () => {
    const harness = createHarness({ agentVersion: 'codex-test-version' });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.metadataUpdates).toHaveLength(1);
    expect(harness.metadataUpdates[0]?.negotiated).toEqual({ agentVersion: 'codex-test-version' });
    expect(harness.negotiatedRegistry).not.toHaveBeenCalled();
    await harness.session.shutdown();
  });

  it('passes the original model through thread creation and xhigh turn start without a model/list gate', async () => {
    const harness = createHarness({
      modelAlias: 'vendor-short',
      thinkingEffort: 'xhigh',
      modelReasoningEfforts: ['low', 'high', 'xhigh'],
    });

    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.modelLists).toEqual([]);
    expect(harness.client.listModels).not.toHaveBeenCalled();
    expect(harness.starts[0]).toMatchObject({ model: 'vendor-short' });
    expect(harness.prompts[0]).toMatchObject({
      threadId: 'thread-new',
      effort: 'xhigh',
    });
    await harness.session.shutdown();
  });

  it('keeps the Codex thread on an idle model/effort change without a directory gate', async () => {
    const harness = createHarness({ models: ['gpt-test', 'gpt-next'], modelReasoningEfforts: ['high', 'xhigh'] });
    const first = await harness.session.run({ kind: 'prompt', prompt: 'first' }, { signal: new AbortController().signal });
    await first.completion;
    await harness.session.settled();
    harness.session.updateBinding({ ...harness.context.binding, modelAlias: 'gpt-next', thinkingLevel: 'xhigh' });
    const second = await harness.session.run({ kind: 'prompt', prompt: 'second' }, { signal: new AbortController().signal });
    await second.completion;
    expect(harness.starts).toHaveLength(1);
    expect(harness.prompts[1]).toMatchObject({ threadId: 'thread-new', model: 'gpt-next', effort: 'xhigh' });
    expect(harness.modelLists).toHaveLength(0);
    expect(harness.client.listModels).not.toHaveBeenCalled();
    await harness.session.shutdown();
  });

  it('passes an explicitly requested Codex effort through without directory prevalidation', async () => {
    const harness = createHarness({
      modelAlias: 'gpt-test',
      thinkingEffort: 'xhigh',
      modelReasoningEfforts: ['low', 'high'],
    });

    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.starts).toHaveLength(1);
    expect(harness.prompts[0]).toMatchObject({ model: 'gpt-test', effort: 'xhigh' });
    expect(harness.modelLists).toEqual([]);
    await harness.session.shutdown();
  });

  it('starts a new Codex thread when the persisted binding fingerprint differs', async () => {
    const harness = createHarness({
      priorThreadId: 'thread-old',
      priorBindingFingerprint: '0'.repeat(64),
      modelAlias: 'model-b',
      thinkingEffort: 'xhigh',
      history: [{
        role: 'user',
        content: [{ type: 'text', text: 'prior work' }],
        toolCalls: [],
      }],
    });

    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.resumes).toEqual([]);
    expect(harness.starts[0]).toMatchObject({ model: 'model-b' });
    expect(harness.prompts[0]).toMatchObject({ effort: 'xhigh' });
    expect(harness.prompts[0]?.['input']).toEqual([
      expect.objectContaining({ text: expect.stringContaining('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF') }),
    ]);
    await harness.session.shutdown();
  });

  it.each(['fail', 'hang'] as const)('runs with an unpinned Codex default when model/list would %s', async (modelListBehavior) => {
    const harness = createHarness({ modelListBehavior, unpinModel: true, thinkingEffort: 'high' });
    try {
      const handle = await harness.session.run(
        { kind: 'prompt', prompt: 'work' },
        { signal: new AbortController().signal },
      );
      await handle.completion;

      expect(harness.client.listModels).not.toHaveBeenCalled();
      expect(harness.starts[0]?.['model']).toBeUndefined();
      expect(harness.prompts[0]).toMatchObject({ effort: 'high' });
      expect(harness.prompts[0]?.['model']).toBeUndefined();
    } finally { await harness.session.shutdown(); }
  });

  it('preserves an invalid model vendor error instead of falling back to a fresh thread', async () => {
    const vendorError = new CodexRemoteError(
      '1', -32602, 'invalid model "vendor-invalid"', { code: 'invalid_model', model: 'vendor-invalid' },
    );
    const harness = createHarness({
      priorThreadId: 'thread-old', modelAlias: 'vendor-invalid', thinkingEffort: 'off', resumeError: vendorError,
    });
    try {
      await expect(harness.session.run(
        { kind: 'prompt', prompt: 'work' },
        { signal: new AbortController().signal },
      )).rejects.toBe(vendorError);
      expect(harness.resumes).toHaveLength(1);
      expect(harness.starts).toHaveLength(0);
      expect(harness.prompts).toHaveLength(0);
    } finally { await harness.session.shutdown(); }
  });

  it('preserves unrelated vendor resume errors instead of falling back to a fresh thread', async () => {
    const vendorError = new CodexRemoteError('1', 429, 'rate limit exceeded');
    const harness = createHarness({ priorThreadId: 'thread-old', thinkingEffort: 'off', resumeError: vendorError });
    try {
      await expect(harness.session.run(
        { kind: 'prompt', prompt: 'work' },
        { signal: new AbortController().signal },
      )).rejects.toBe(vendorError);
      expect(harness.resumes).toHaveLength(1);
      expect(harness.starts).toHaveLength(0);
      expect(harness.prompts).toHaveLength(0);
    } finally { await harness.session.shutdown(); }
  });

  it('round-trips a structured command decision by its exact option id', async () => {
    const decision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'example.test', action: 'allow' },
      },
    };
    const harness = createHarness({ approvalOptionId: `json:${JSON.stringify(decision)}` });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'network' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.serverResults).toEqual([{ decision }]);
    await harness.session.shutdown();
  });

  it.each([
    ['omitted', undefined],
    ['true', true],
  ])('round-trips blocking user input when isBlocking is %s', async (_name, isBlocking) => {
    const params: Record<string, unknown> = {
      threadId: 'thread-new',
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Choose a language',
          options: [{ label: 'TypeScript', description: 'Use TypeScript' }],
        },
        {
          id: 'runner',
          header: 'Runner',
          question: 'Choose a test runner',
          options: [{ label: 'Vitest', description: 'Use Vitest' }],
        },
      ],
    };
    if (isBlocking !== undefined) params['isBlocking'] = isBlocking;
    const harness = createHarness({
      questionAnswers: { '0': 'TypeScript', '1': 'Vitest' },
      serverRequest: { method: 'item/tool/requestUserInput', params },
    });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'configure' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.questionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'codex:42',
        questions: [
          {
            question: 'Choose a language',
            header: 'Language',
            options: [{ label: 'TypeScript', description: 'Use TypeScript' }],
            multiSelect: false,
          },
          {
            question: 'Choose a test runner',
            header: 'Runner',
            options: [{ label: 'Vitest', description: 'Use Vitest' }],
            multiSelect: false,
          },
        ],
      }),
      expect.objectContaining({ agentId: 'codex-agent' }),
    );
    expect(harness.serverResults).toEqual([{
      answers: {
        language: { answers: ['TypeScript'] },
        runner: { answers: ['Vitest'] },
      },
    }]);
    await harness.session.shutdown();
  });

  it('rejects secret user input without creating a durable question interaction', async () => {
    const secret = 'TOP_SECRET_SHOULD_NOT_PERSIST';
    const harness = createHarness({
      questionAnswer: secret,
      serverRequest: {
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-new',
          turnId: 'turn-1',
          itemId: 'input-1',
          isBlocking: true,
          questions: [{
            id: 'password',
            header: 'Credential',
            question: 'Enter a password',
            isSecret: true,
            options: null,
          }],
        },
      },
    });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'authenticate' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.serverResults).toEqual([{
      error: { code: -32601, message: 'Secret user input is unsupported' },
    }]);
    expect(harness.questionRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.events)).not.toContain(secret);
    await harness.session.shutdown();
  });

  it('rejects non-blocking user input instead of treating it as blocking', async () => {
    const harness = createHarness({
      serverRequest: {
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-new',
          turnId: 'turn-1',
          itemId: 'input-1',
          isBlocking: false,
          questions: [{
            id: 'choice',
            header: 'Choice',
            question: 'Choose',
            isSecret: false,
            options: null,
          }],
        },
      },
    });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'choose' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.serverResults).toEqual([{
      error: { code: -32601, message: 'Non-blocking user input is unsupported' },
    }]);
    expect(harness.questionRequest).not.toHaveBeenCalled();
    await harness.session.shutdown();
  });

  it.each([
    ['non-boolean isBlocking', { isBlocking: 'false', questions: [] }],
    ['missing questions', { isBlocking: true }],
    ['non-boolean isSecret', {
      isBlocking: true,
      questions: [{
        id: 'choice',
        header: 'Choice',
        question: 'Choose',
        isSecret: 'true',
        options: null,
      }],
    }],
  ])('rejects malformed user input payloads: %s', async (_name, payload) => {
    const harness = createHarness({
      serverRequest: {
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-new',
          turnId: 'turn-1',
          itemId: 'input-1',
          ...payload,
        },
      },
    });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'choose' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.serverResults).toEqual([{
      error: { code: -32602, message: 'Invalid user input question payload' },
    }]);
    expect(harness.questionRequest).not.toHaveBeenCalled();
    await harness.session.shutdown();
  });

  it('records unsupported item projection as a fidelity loss', async () => {
    const harness = createHarness({
      turnEvents: [{ type: 'unknown', updateType: 'item/completed:webSearch' }],
    });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'search' },
      { signal: new AbortController().signal },
    );

    await handle.completion;
    expect(harness.events.find((event) => event instanceof ExecutorTurnMetadata)).toMatchObject({
      losses: expect.arrayContaining(['unknown_update_dropped']),
    });
    await harness.session.shutdown();
  });

  it('keeps a coded Codex tool failure on the durable tool result', async () => {
    const harness = createHarness({ turnEvents: [
      { type: 'tool.call', toolCallId: 'mcp-1', title: 'kiki-harness/kiki_list', kind: 'mcp', status: 'inProgress', rawInput: {} },
      { type: 'tool.update', toolCallId: 'mcp-1', status: 'failed', rawOutput: { message: 'denied' }, errorCode: 'codex_mcp_approval_denied' },
      { type: 'tool.call', toolCallId: 'cmd-1', title: 'ls', kind: 'command', status: 'inProgress', rawInput: {} },
      { type: 'tool.update', toolCallId: 'cmd-1', status: 'completed', rawOutput: 'ok', errorCode: 'ignored_on_success' },
    ] });
    const handle = await harness.session.run({ kind: 'prompt', prompt: 'list' }, { signal: new AbortController().signal });
    await handle.completion;
    const results = harness.loopEvents.filter((event) => (event as { type: string }).type === 'tool.result') as { result: { isError?: boolean; errorCode?: string } }[];
    expect(results.map((event) => [event.result.isError, event.result.errorCode])).toEqual([
      [true, 'codex_mcp_approval_denied'], [false, undefined],
    ]);
    await harness.session.shutdown();
  });

  it('resumes an unpinned Codex main thread with the harness default model', async () => {
    const harness = createHarness({ priorThreadId: 'thread-old', unpinModel: true, thinkingEffort: 'off' });
    const handle = await harness.session.run({ kind: 'prompt', prompt: 'Continue' },
      { signal: new AbortController().signal });
    await handle.completion;
    expect(harness.resumes).toHaveLength(1);
    expect(harness.starts).toHaveLength(0);
    expect(harness.prompts[0]?.['model']).toBeUndefined();
    expect(JSON.stringify(harness.prompts[0])).not.toContain('"model"');
    expect(harness.usageRecords[0]?.[3]).toMatchObject({
      modelAlias: undefined, executorId: 'codex-app-server',
    });
    await harness.session.shutdown();
  });

  it('resumes imported Codex threads and preserves source provenance on later turns', async () => {
    const harness = createHarness({ priorThreadId: 'foreign-thread', localSource: true });
    try {
      for (const prompt of ['Continue', 'Continue again']) {
        await (await harness.session.run({ kind: 'prompt', prompt }, { signal: new AbortController().signal })).completion;
        await harness.session.settled();
      }
      expect(harness.resumes[0]).toMatchObject({ threadId: 'foreign-thread' });
      expect(harness.starts).toHaveLength(0);
      const updates = harness.events.filter((event) => event instanceof ExecutorSessionUpdated);
      expect(updates).toHaveLength(2);
      expect(updates.every((event) => event.sessionRef.ref['localSource'] !== undefined)).toBe(true);
    } finally { await harness.session.shutdown(); }
  });

  it.each(['fingerprint', 'missing_thread'] as const)('rejects imported Codex %s failures without a fresh thread or a prompt', async (failure) => {
    const harness = createHarness({ priorThreadId: 'foreign-thread', localSource: true,
      priorBindingFingerprint: failure === 'fingerprint' ? '0'.repeat(64) : undefined,
      resumeError: failure === 'missing_thread' ? new CodexRemoteError('1', -32602, 'unknown thread') : undefined });
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'Continue' }, { signal: new AbortController().signal })).rejects.toThrow();
      expect(harness.starts).toHaveLength(0);
      expect(harness.prompts).toHaveLength(0);
    } finally { await harness.session.shutdown(); }
  });

  it('falls back to a fresh thread only for protocol resume failures', async () => {
    const history: ContextMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'prior request' }],
      toolCalls: [],
      origin: { kind: 'user' },
    }];
    const recoverable = createHarness({
      priorThreadId: 'thread-old',
      resumeError: new CodexRemoteError('1', -32602, 'unknown thread'),
      history,
    });
    const handle = await recoverable.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await handle.completion;
    expect(recoverable.starts).toHaveLength(1);
    expect(recoverable.prompts[0]?.['input']).toEqual([
      expect.objectContaining({ text: expect.stringContaining('PRIOR TRANSCRIPT HANDOFF') }),
    ]);
    expect(recoverable.events.find((event) => event instanceof ExecutorTurnMetadata)).toMatchObject({
      resumeMode: 'handoff',
      losses: expect.arrayContaining(['resume_new_session_handoff']),
    });
    await recoverable.session.shutdown();

    const transport = createHarness({
      priorThreadId: 'thread-old',
      resumeError: new CodexClientError('closed', 'process exited'),
    });
    await expect(transport.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/process exited/);
    expect(transport.starts).toHaveLength(0);
    await transport.session.shutdown();
  });

  it.each(['sub', 'independent'] as const)('sends the saved cold %s identity through Codex developer instructions', async (position) => {
    const harness = createExecutionHarness();
    const adapter = harness.ix.get(IAgentProfileService);
    const cold = await coldPromptFixture(position, adapter.data(), harness.ix.get(IAgentExecutorRegistry));
    vi.spyOn(adapter, 'data').mockImplementation(() => cold.profile.data());
    vi.spyOn(adapter, 'preparePromptConfiguration').mockImplementation(() => cold.profile.preparePromptConfiguration());
    vi.spyOn(adapter, 'getSystemPrompt').mockImplementation(() => cold.profile.getSystemPrompt());
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      const sent = String(harness.starts[0]?.['developerInstructions']);
      expect(sent).toBe(cold.before.systemPrompt);
      expect(sent).toContain('Role OLD');
      expect(sent).not.toContain('Role NEW');
      expect(sent).not.toContain('SHARED_NEW');
      expect(cold.profile.data().boundProfile?.promptBase?.inputs).toEqual(cold.before.boundProfile?.promptBase?.inputs);
      const snippet = cold.before.boundProfile?.promptBase?.delegationSnippet;
      expect(snippet).toBeTruthy();
      expect(sent).not.toContain(snippet!);
      expect(cold.profile.data().executorId).toBe(cold.before.executorId);
      await harness.execution.shutdown();
      await expect(run.completion).rejects.toBeDefined();
    } finally { await harness.ix.dispose(); await harness.execution.shutdown(); await cold.dispose(); }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['scope-close', 'shutdown', 'dispose', 'replacement'] as const)(
    'cancels a deferred Codex turn and closes the real DI-owned session during %s',
    async (close) => {
      const harness = createExecutionHarness();
      const errors = vi.spyOn(console, 'error');
      const executionDispose = vi.spyOn(harness.execution, 'dispose');
      try {
        const run = await harness.execution.run(
          { kind: 'prompt', prompt: 'work' },
          { signal: new AbortController().signal },
        );
        expect(harness.starts[0]?.['developerInstructions']).toBe('Frozen profile instructions');
        harness.pendingTurns.add(run.turn.id);
        if (close === 'scope-close') await harness.ix.dispose();
        if (close === 'replacement') {
          harness.ix.provide(IAgentLoopService, {} as IAgentLoopService);
          await harness.ix.cascade.whenIdle();
          expect(executionDispose).toHaveBeenCalledTimes(1);
        }
        if (close === 'shutdown') await harness.execution.shutdown('test shutdown');
        if (close === 'dispose') await harness.execution.dispose();
        if (close === 'scope-close') expect(executionDispose).toHaveBeenCalledTimes(1);

        await expect(run.completion).rejects.toBeDefined();
        await harness.execution.settled();
        await harness.execution.shutdown();
        await harness.execution.dispose();

        if (close === 'replacement') {
          expect(harness.ix.get(IAgentExecutionService)).not.toBe(harness.execution);
        }
        expect(run.turn.signal.aborted).toBe(true);
        expect(harness.turnCancel).toHaveBeenCalled();
        expect(harness.pendingTurns.has(run.turn.id)).toBe(false);
        expect(harness.interaction.cancelPendingForTurn).toHaveBeenCalledWith(run.turn.id, 'codex-agent');
        expect(harness.client.shutdown).toHaveBeenCalledTimes(1);
        expect(harness.runtimeLease.dispose).toHaveBeenCalledTimes(1);
        expect(harness.execution.status()).toEqual({ state: 'idle' });
      } finally {
        await harness.ix.dispose();
        await harness.execution.shutdown();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      }
    },
  );
});

describe('Codex Kiki MCP approval under YOLO', () => {
  const approvalFlags = (args: readonly string[]) => args.filter((arg) => arg.includes('default_tools_approval_mode'));

  it('launches Codex with only the Kiki MCP server pre-approved in YOLO, keeping never and the workspace sandbox', async () => {
    const harness = createHarness({ kikiSubagents: true, permissionMode: { mode: 'yolo' } });
    try {
      await (await harness.session.run({ kind: 'prompt', prompt: 'delegate' }, { signal: new AbortController().signal })).completion;
      expect(harness.spawns).toHaveLength(1);
      expect(approvalFlags(harness.spawns[0]!)).toEqual(['mcp_servers.kiki-harness.default_tools_approval_mode="approve"']);
      expect(harness.spawns[0]!.join(' ')).not.toMatch(/mcp_servers\.(?!kiki-harness\.)[^.=]+\.default_tools_approval_mode/);
      expect(harness.spawns[0]!.join(' ')).not.toMatch(/approval_policy|sandbox_mode|danger-full-access|bypass/);
      expect(harness.starts[0]).toMatchObject({ approvalPolicy: 'never', sandbox: 'workspace-write' });
      expect(harness.prompts[0]).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } });
    } finally { await harness.session.shutdown(); }
  });

  it('keeps Codex asking for the Kiki MCP server outside YOLO', async () => {
    for (const mode of ['manual', 'auto'] as const) {
      const harness = createHarness({ kikiSubagents: true, permissionMode: { mode } });
      try {
        await (await harness.session.run({ kind: 'prompt', prompt: 'delegate' }, { signal: new AbortController().signal })).completion;
        expect(approvalFlags(harness.spawns[0]!)).toEqual([]);
        expect(harness.spawns[0]!.join(' ')).toContain('mcp_servers.kiki-harness.command="kiki"');
        expect(harness.prompts[0]).toMatchObject({ approvalPolicy: 'on-request' });
      } finally { await harness.session.shutdown(); }
    }
  });

  it('adds nothing when Kiki MCP is not injected, even in YOLO', async () => {
    const harness = createHarness({ permissionMode: { mode: 'yolo' } });
    try {
      await (await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).completion;
      expect(harness.spawns[0]).toEqual(['app-server']);
    } finally { await harness.session.shutdown(); }
  });

  it('restarts Codex and resumes the same thread when the mode crosses YOLO between turns', async () => {
    const mode: { mode: 'manual' | 'auto' | 'yolo' } = { mode: 'manual' };
    const harness = createHarness({ kikiSubagents: true, permissionMode: mode });
    try {
      await (await harness.session.run({ kind: 'prompt', prompt: 'one' }, { signal: new AbortController().signal })).completion; await harness.session.settled();
      await (await harness.session.run({ kind: 'prompt', prompt: 'two' }, { signal: new AbortController().signal })).completion; await harness.session.settled();
      expect(harness.spawns).toHaveLength(1);
      mode.mode = 'yolo';
      await (await harness.session.run({ kind: 'prompt', prompt: 'three' }, { signal: new AbortController().signal })).completion; await harness.session.settled();
      expect(harness.client.shutdown).toHaveBeenCalledOnce();
      expect(harness.spawns).toHaveLength(2);
      expect(approvalFlags(harness.spawns[1]!)).toHaveLength(1);
      expect(harness.resumes.at(-1)).toMatchObject({ threadId: 'thread-new', approvalPolicy: 'never' });
      mode.mode = 'auto';
      await (await harness.session.run({ kind: 'prompt', prompt: 'four' }, { signal: new AbortController().signal })).completion; await harness.session.settled();
      expect(harness.spawns).toHaveLength(3);
      expect(approvalFlags(harness.spawns[2]!)).toEqual([]);
    } finally { await harness.session.shutdown(); }
  });
});

describe('Codex native MCP elicitation', () => {
  it('keeps sibling approvals pending when one MCP approval is cancelled during an active turn', async () => {
    const ix = new TestInstantiationService();
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
    const interaction = ix.get(ISessionInteractionService);
    const approvals = ix.get(ISessionApprovalService);
    interaction.acquireConsumer('test');
    const harness = createHarness({ deferTurnCompletion: true, serverRequest: {
      method: 'mcpServer/elicitation/request', params: {
        threadId: 'thread-new', turnId: 'turn-1', serverName: 'example', mode: 'form', message: 'Allow?',
        requestedSchema: { type: 'object', properties: {} },
      },
    } });
    vi.spyOn(harness.interaction, 'cancelPendingForTurn').mockImplementation((turnId, agentId) => interaction.cancelPendingForTurn(turnId, agentId));
    vi.spyOn(harness.approval, 'request').mockImplementation((req) => {
      const primary = approvals.request({ ...req, id: 'primary' });
      void approvals.request({ ...req, id: 'sibling', display: { kind: 'command', command: 'echo ok' } });
      expect(interaction.listPending().map((entry) => entry.id)).toEqual(['primary', 'sibling']);
      interaction.respond('primary', { decision: 'cancelled' });
      return primary;
    });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      void run.completion.catch(() => undefined);
      expect(run.turn.signal.aborted).toBe(false);
      expect(harness.serverResults).toEqual([{ action: 'cancel', content: null }]);
      expect(interaction.listPending().map((entry) => entry.id)).toEqual(['sibling']);
      expect(harness.interaction.cancelPendingForTurn).not.toHaveBeenCalled();
      await harness.session.shutdown();
      expect(interaction.listPending()).toEqual([]);
    } finally {
      await harness.session.shutdown();
      await ix.dispose();
    }
  });
  it('maps a real empty-schema MCP approval and does not require an absent itemId', async () => {
    const harness = createHarness({ serverRequest: { method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-new', turnId: 'turn-1', serverName: 'kiki-harness', mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
      message: 'Allow kiki_list?', requestedSchema: { type: 'object', properties: {} },
    } } });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'List' }, { signal: new AbortController().signal });
      await run.completion;
      expect(harness.serverResults).toEqual([{ action: 'accept', content: null }]);
    } finally { await harness.session.shutdown(); }
  });

  it('declines a form for another thread and unsupported URL elicitation', async () => {
    for (const params of [{ threadId: 'other', mode: 'form' }, { threadId: 'thread-new', mode: 'url' }]) {
      const harness = createHarness({ serverRequest: { method: 'mcpServer/elicitation/request', params: { ...params,
        message: 'Allow?', requestedSchema: { type: 'object', properties: {} } } } });
      try {
        const run = await harness.session.run({ kind: 'prompt', prompt: 'List' }, { signal: new AbortController().signal });
        await run.completion;
        expect(harness.serverResults).toEqual([{ action: 'decline', content: null }]);
      } finally { await harness.session.shutdown(); }
    }
  });

  it('returns typed content for a native MCP form using the same durable question mapping', async () => {
    const harness = createHarness({ questionAnswers: { Choice: 'Safe' }, serverRequest: { method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-new', mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {
        choice: { type: 'string', title: 'Choice', oneOf: [{ const: 'safe', title: 'Safe' }] },
      }, required: ['choice'] },
    } } });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'Choose' }, { signal: new AbortController().signal });
      await run.completion;
      expect(harness.serverResults).toEqual([{ action: 'accept', content: { choice: 'safe' } }]);
    } finally { await harness.session.shutdown(); }
  });
});

function realProtocolProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const methods: string[] = [];
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let releaseDispose!: () => void;
  const disposal = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const dispose = vi.fn(async () => { await disposal; });
  const kill = vi.fn(async () => {});
  let turnIndex = 0;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const frame = JSON.parse(line) as { id?: string; method?: string };
        if (frame.method !== undefined) methods.push(frame.method);
        if (frame.id === undefined) continue;
        let result: unknown = {};
        if (frame.method === 'model/list') result = { data: [{ id: 'gpt-test' }], nextCursor: null };
        if (frame.method === 'thread/start' || frame.method === 'thread/resume') result = { thread: { id: 'thread-1' } };
        if (frame.method === 'turn/start') result = { turn: { id: `turn-${++turnIndex}` } };
        stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
      }
      callback();
    },
  });
  const process: HostProcessLike = {
    pid: 42, get exitCode() { return exitCode; }, stdin, stdout, stderr,
    wait: () => exited, kill, dispose,
  };
  return {
    process, stdout, methods, dispose, kill, releaseDispose,
    exit: () => { exitCode = 0; resolveExit(0); },
    complete: (status = 'completed', error?: Readonly<Record<string, unknown>>) => {
      stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: `turn-${turnIndex}`, itemId: 'message-1', delta: 'done',
      } })}\n`);
      stdout.write(`${JSON.stringify({ method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: `turn-${turnIndex}`, status, error },
      } })}\n`);
    },
  };
}

describe('real Codex client through execution settlement and capacity', () => {
  it('preserves the structured vendor error message in failed turn results', async () => {
    const fixture = realProtocolProcess();
    const harness = createExecutionHarness({ clientFactory: (_processes, onServerRequest) =>
      new CodexAppServerClient({ spawn: async () => fixture.process }, {
        id: 'fixture', command: 'fixture', shutdownGraceMs: 5,
      }, { onServerRequest }) });
    const message = 'stream disconnected before completion: stream closed before response.completed';
    const vendorError = { message, codexErrorInfo: 'other' };
    try {
      const handle = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      const completion = handle.completion.catch((error: unknown) => error);
      fixture.complete('failed', vendorError);
      expect(await completion).toMatchObject({ message });
      await harness.execution.settled();
      const result = await handle.turn.result;
      expect(result).toMatchObject({ type: 'failed', error: { message, code: 'remote', data: vendorError } });
      if (result.type !== 'failed') throw new Error('Expected failed turn');
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).toContain(message);
    } finally {
      fixture.exit();
      fixture.releaseDispose();
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it.each(['abort', 'shutdown', 'eof'] as const)('retains capacity until process exit and disposal on %s', async (kind) => {
    const fixture = realProtocolProcess();
    const harness = createExecutionHarness({ clientFactory: (_processes, onServerRequest) =>
      new CodexAppServerClient({ spawn: async () => fixture.process }, {
        id: 'fixture', command: 'fixture', shutdownGraceMs: 5,
      }, { onServerRequest }) });
    const signal = new AbortController();
    let shutdown: Promise<void> | undefined;
    try {
      const handle = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: signal.signal });
      const completion = handle.completion.catch((error: unknown) => error);
      let settled = false;
      void completion.then(() => { settled = true; });
      const reserve = () => harness.capacity.reserve('main', { maxDirectChildren: 1, maxTotalSubagents: 1 }, 'codex-agent');
      if (kind === 'abort') signal.abort(new Error('cancelled'));
      if (kind === 'shutdown') shutdown = harness.execution.shutdown(new Error('closed'));
      if (kind === 'eof') fixture.stdout.end();
      await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalled(), { interval: 1 });
      expect(settled).toBe(false);
      expect(() => reserve()).toThrow(/already starting or running/);
      if (kind !== 'eof') expect(fixture.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1);
      fixture.exit();
      await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce(), { interval: 1 });
      expect(settled).toBe(false);
      expect(() => reserve()).toThrow(/already starting or running/);
      fixture.releaseDispose();
      expect(await completion).toBeInstanceOf(Error);
      await harness.execution.settled();
      expect((await handle.turn.result).type).toBe(kind === 'eof' ? 'failed' : 'cancelled');
      const release = reserve();
      release();
      if (shutdown !== undefined) {
        await shutdown;
        expect(harness.runtimeLease.dispose).toHaveBeenCalledOnce();
      }
      expect(fixture.dispose).toHaveBeenCalledOnce();
    } finally {
      fixture.exit();
      fixture.releaseDispose();
      await shutdown;
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('records normal terminal output, releases capacity and runs a later turn on the same client', async () => {
    const fixture = realProtocolProcess();
    const harness = createExecutionHarness({ clientFactory: (_processes, onServerRequest) =>
      new CodexAppServerClient({ spawn: async () => fixture.process }, {
        id: 'fixture', command: 'fixture', shutdownGraceMs: 5,
      }, { onServerRequest }) });
    try {
      for (let index = 0; index < 2; index++) {
        const handle = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
        fixture.complete();
        await expect(handle.completion).resolves.toMatchObject({ summary: 'done' });
        await harness.execution.settled();
        const release = harness.capacity.reserve('main', { maxDirectChildren: 1, maxTotalSubagents: 1 }, 'codex-agent');
        release();
        expect((await handle.turn.result).type).toBe('completed');
      }
      expect(fixture.methods.filter((method) => method === 'turn/start')).toHaveLength(2);
      expect(fixture.methods.filter((method) => method === 'thread/start')).toHaveLength(1);
    } finally {
      fixture.exit();
      fixture.releaseDispose();
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });
});
