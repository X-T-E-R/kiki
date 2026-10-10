import { PassThrough, Writable } from 'node:stream';
import { DispatchCapacity } from '#/session/dispatch/capacity';
import {
  CodexAppServerClient,
  type HostProcessLike,
  CodexClientError,
  CodexRemoteError,
  type CodexServerRequestHandler,
  type CodexNotification,
  type CodexTurnCompletion,
  type CodexTurnHandle,
  type NormalizedExecutorEvent,
} from '@kiki/codex-client';
import { describe, expect, it, vi } from 'vitest';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { coldPromptFixture } from './coldPromptFixture';
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
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { appendSharedPromptField } from '#/app/promptField/builtinPromptFields';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { CodexAppServerExecutorSession } from '#/agent/execution/codexAppServerExecutorSession';
import {
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
  readonly modelReasoningEfforts?: readonly string[];
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
  readonly notifications?: readonly CodexNotification[];
  readonly permissionGate?: IAgentPermissionGate['authorize'];
  readonly questionAnswer?: string;
  readonly questionAnswers?: Readonly<Record<string, string>>;
  readonly deferTurnCompletion?: boolean;
  readonly steerResponse?: unknown;
  readonly permissionMode?: { mode: 'manual' | 'auto' | 'yolo' };
  readonly vendorApprovalPolicy?: string | Readonly<Record<string, unknown>>;
  readonly failTurnStart?: boolean;
  readonly kikiSubagents?: boolean;
  readonly clientFactory?: ConstructorParameters<typeof CodexAppServerExecutorSession>[1];
}

function asyncEvents(events: readonly NormalizedExecutorEvent[]): AsyncIterable<NormalizedExecutorEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
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
    flush: async () => wire.flush(),
    dispatch: async (event: Event2) => {
      events.push(event);
      if (event instanceof TurnPrompt) {
        stateValues.set(turnKey, { nextTurnId: event.turnId! + 1, cancelledTurnIds: [] });
      }
      if (event instanceof ExecutorSessionUpdated) {
        stateValues.set(externalExecutorKey, {
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
      identity: { runtimeId: 'local' },
      environment: { pathClass: 'win32', homeDir: 'C:/home/example', osKind: 'windows', shellName: 'powershell' },
      fs: { realpath: async (path: string) => path },
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
  const services = new Map<unknown, unknown>([
    [IAgentStateService, states],
    [IAgentPermissionModeService, Object.assign(options.permissionMode ?? { mode: 'manual' }, { setMode: vi.fn() })],
    [IAgentPermissionRulesService, { rules: [] }],
    [IAgentPermissionGate, { authorize: options.permissionGate }],
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
    [IAgentExecutorRegistry, { recordNegotiated: vi.fn() }],
    [ISessionMetadata, { read: async () => ({ agents: {} }), getAgentExecutor: async () => undefined, registerAgent: vi.fn(), updateAgent: vi.fn(async () => {}) }],
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
  let notificationHandler: ((notification: CodexNotification) => void) | undefined;
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
      ? { state: 'ready' as const }
      : { state: 'turning' as const, threadId: 'thread-new', turnId: 'turn-1' },
    request: vi.fn(async (_method: string, _params: unknown) => options.steerResponse ?? { turnId: 'turn-1' }),
    connect: async () => {},
    listModels: async () => {
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
    },
    startThread: async (params: Readonly<Record<string, unknown>>) => {
      starts.push(params);
      return { thread: { id: 'thread-new' }, approvalPolicy: options.vendorApprovalPolicy ?? 'untrusted' };
    },
    resumeThread: async (params: Readonly<Record<string, unknown>>) => {
      resumes.push(params);
      if (options.resumeError !== undefined) {
        throw options.resumeError instanceof Error
          ? options.resumeError
          : new Error('Configured resume failure');
      }
      return { thread: { id: String(params['threadId']) }, approvalPolicy: options.vendorApprovalPolicy ?? 'untrusted' };
    },
    startTurn: async (params: Readonly<Record<string, unknown>>): Promise<CodexTurnHandle> => {
      prompts.push(params);
      if (options.failTurnStart) throw new Error('turn start failed');
      for (const notification of options.notifications ?? []) notificationHandler?.(notification);
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
      return {
        events: asyncEvents(options.turnEvents ?? [
          {
            type: 'message.delta',
            role: 'assistant',
            messageId: 'message-1',
            content: { type: 'text', text: 'done' },
          },
        ]),
        completion,
        cancel: turnCancel,
      };
    },
    shutdown: vi.fn(async () => {}),
  };
  const spawns: (readonly string[])[] = [];
  const createSession = (executorContext: AgentExecutorContext) => new CodexAppServerExecutorSession(
    executorContext,
    (processes, handler, onNotification) => {
      if (options.clientFactory !== undefined) return options.clientFactory(processes, handler, onNotification);
      serverHandler = handler;
      notificationHandler = onNotification;
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
  ix.stub(ISessionMetadata, { read: async () => ({ id: 's1', createdAt: 1, updatedAt: 1, archived: false, agents: {} }), getAgentExecutor: async () => undefined, registerAgent: vi.fn(), updateAgent: vi.fn(async () => {}) });
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
  it('projects Codex fileChange facts to every actual Write path before approval without private metadata', async () => {
    const permissionGate = vi.fn<IAgentPermissionGate['authorize']>(async (context) => {
      expect(context.toolCall.name).toBe('Write');
      expect(context.execution.accesses).toEqual([
        { kind: 'file', operation: 'write', path: 'C:/workspace/allowed.ts', implicitExternal: false },
        { kind: 'file', operation: 'write', path: 'C:/workspace/blocked.ts', implicitExternal: false },
      ]);
      expect(context.execution.matchesRule?.('C:/workspace/blocked.ts', 'any')).toBe(true);
      expect(context.execution.matchesRule?.('C:/workspace/allowed.ts', 'all')).toBe(false);
      return { permissionDecision: 'rejected', veto: { isError: true, output: 'Explicit Write deny' } };
    });
    const harness = createHarness({ permissionGate, notifications: [{ method: 'item/started', params: {
      threadId: 'thread-new', turnId: 'turn-1', item: { id: 'file-1', type: 'fileChange', status: 'inProgress',
        changes: [{ path: 'C:/workspace/allowed.ts', kind: 'add', diff: 'neutral' },
          { path: 'C:/workspace/blocked.ts', kind: 'update', diff: 'neutral' }] },
    } }], serverRequest: { method: 'item/fileChange/requestApproval', params: {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'file-1', grantRoot: 'C:/workspace',
    } } });
    Object.assign(harness.context.binding, { permissionMode: 'yolo' });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'neutral fixture' }, { signal: new AbortController().signal });
    await run.completion;
    expect(permissionGate).toHaveBeenCalledTimes(1);
    expect(harness.serverResults).toEqual([{ decision: 'decline' }]);
    await harness.session.shutdown();
  });

  it.each(['missing facts', 'other item', 'other turn', 'other thread', 'request other thread'] as const)(
    'does not guess Codex fileChange paths from grantRoot with %s', async (mismatch) => {
      const permissionGate = vi.fn<IAgentPermissionGate['authorize']>(async () => undefined);
      const harness = createHarness({ permissionGate, notifications: mismatch === 'missing facts' ? [] : [{ method: 'item/started', params: {
        threadId: mismatch === 'other thread' ? 'thread-other' : 'thread-new',
        turnId: mismatch === 'other turn' ? 'turn-other' : 'turn-1', item: {
          id: mismatch === 'other item' ? 'file-other' : 'file-1', type: 'fileChange',
          changes: [{ path: 'C:/workspace/allowed.ts', kind: 'add', diff: 'neutral' }],
        },
      } }], serverRequest: { method: 'item/fileChange/requestApproval', params: {
        threadId: mismatch === 'request other thread' ? 'thread-other' : 'thread-new',
        turnId: 'turn-1', itemId: 'file-1', grantRoot: 'C:/workspace',
      } } });
      Object.assign(harness.context.binding, { permissionMode: 'yolo' });
      const run = await harness.session.run({ kind: 'prompt', prompt: 'neutral fixture' }, { signal: new AbortController().signal });
      await run.completion;
      expect(permissionGate).not.toHaveBeenCalled();
      expect(harness.serverResults).toEqual([{ error: { code: -32602,
        message: mismatch === 'request other thread' ? 'File approval belongs to a different thread'
          : 'File approval has no matching fileChange paths for the active item and turn' } }]);
      await harness.session.shutdown();
    },
  );
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
      approvalPolicy: undefined,
      sandbox: undefined,
      developerInstructions: 'Frozen profile instructions',
    });
    expect(harness.prompts[0]).toMatchObject({
      effort: 'high',
      approvalPolicy: undefined,
      sandboxPolicy: undefined,
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
      mailbox.dispose();
      await harness.execution.shutdown();
      harness.ix.dispose();
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

  it('passes the original model through model/list, thread creation, and xhigh turn start', async () => {
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

    expect(harness.modelLists).toEqual([['vendor-short']]);
    expect(harness.starts[0]).toMatchObject({ model: 'vendor-short' });
    expect(harness.prompts[0]).toMatchObject({
      threadId: 'thread-new',
      effort: 'xhigh',
    });
    await harness.session.shutdown();
  });

  it('keeps the Codex thread on an idle model/effort change and revalidates the new model', async () => {
    const harness = createHarness({ models: ['gpt-test', 'gpt-next'], modelReasoningEfforts: ['high', 'xhigh'] });
    const first = await harness.session.run({ kind: 'prompt', prompt: 'first' }, { signal: new AbortController().signal });
    await first.completion;
    await harness.session.settled();
    harness.session.updateBinding({ ...harness.context.binding, modelAlias: 'gpt-next', thinkingLevel: 'xhigh' });
    const second = await harness.session.run({ kind: 'prompt', prompt: 'second' }, { signal: new AbortController().signal });
    await second.completion;
    expect(harness.starts).toHaveLength(1);
    expect(harness.prompts[1]).toMatchObject({ threadId: 'thread-new', model: 'gpt-next', effort: 'xhigh' });
    expect(harness.modelLists).toHaveLength(2);
    await harness.session.shutdown();
  });

  it('rejects an explicitly unsupported Codex effort before thread and turn start', async () => {
    const harness = createHarness({
      modelAlias: 'gpt-test',
      thinkingEffort: 'xhigh',
      modelReasoningEfforts: ['low', 'high'],
    });

    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/thinking effort "xhigh" is not advertised/);

    expect(harness.starts).toEqual([]);
    expect(harness.resumes).toEqual([]);
    expect(harness.prompts).toEqual([]);
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

  it('fails closed when model/list does not advertise the pinned id', async () => {
    const harness = createHarness({ models: ['other-model'] });

    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/not advertised/);
    expect(harness.starts).toHaveLength(0);
    await harness.session.shutdown();
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

  it.each(['sub', 'independent'] as const)('sends the refreshed cold %s identity through Codex developer instructions', async (position) => {
    const harness = createExecutionHarness();
    const adapter = harness.ix.get(IAgentProfileService);
    const cold = await coldPromptFixture(position, adapter.data(), harness.ix.get(IAgentExecutorRegistry));
    vi.spyOn(adapter, 'data').mockImplementation(() => cold.profile.data());
    vi.spyOn(adapter, 'preparePromptConfiguration').mockImplementation(() => cold.profile.preparePromptConfiguration());
    vi.spyOn(adapter, 'getSystemPrompt').mockImplementation(() => cold.profile.getSystemPrompt());
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      const sent = String(harness.starts[0]?.['developerInstructions']);
      expect(sent).toContain('Role NEW');
      expect(sent).not.toContain('Role OLD');
      expect(sent).not.toContain('SHARED_NEW');
      const snippet = cold.before.boundProfile?.promptBase?.delegationSnippet;
      expect(snippet).toBeTruthy();
      expect(sent).not.toContain(snippet!);
      expect(cold.profile.data().executorId).toBe(cold.before.executorId);
      await harness.execution.shutdown();
      await expect(run.completion).rejects.toBeDefined();
    } finally { harness.ix.dispose(); await harness.execution.shutdown(); await cold.dispose(); }
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
        if (close === 'scope-close') harness.ix.dispose();
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
        harness.ix.dispose();
        await harness.execution.shutdown();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      }
    },
  );
});

describe('Codex Kiki MCP approval under YOLO', () => {
  it.each([false, true])('restores sticky vendor approval after clear on the same thread (cold=%s)', async (cold) => {
    const vendorApprovalPolicy = { granular: { sandbox_approval: true, rules: true, skill_approval: false,
      request_permissions: true, mcp_elicitations: false } };
    const harness = createHarness({ vendorApprovalPolicy });
    Object.assign(harness.context.binding, { permissionMode: 'yolo' });
    let session = harness.session;
    try {
      await (await session.run({ kind: 'prompt', prompt: 'first' }, { signal: new AbortController().signal })).completion;
      await session.settled();
      expect(harness.prompts[0]?.['approvalPolicy']).toBe('never');
      expect(harness.states.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toEqual({ threadId: 'thread-new', policy: vendorApprovalPolicy });
      Object.assign(harness.context.binding, { permissionMode: undefined });
      if (cold) { await session.shutdown(); session = harness.createSession(harness.context); }
      await (await session.run({ kind: 'prompt', prompt: 'second' }, { signal: new AbortController().signal })).completion;
      await session.settled();
      expect(harness.prompts[1]?.['approvalPolicy']).toEqual(vendorApprovalPolicy);
      expect(harness.states.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toBeUndefined();
      expect(harness.starts).toHaveLength(1);
      expect(harness.prompts.map((prompt) => prompt['threadId'])).toEqual(['thread-new', 'thread-new']);
      await (await session.run({ kind: 'prompt', prompt: 'third' }, { signal: new AbortController().signal })).completion;
      expect(harness.prompts[2]?.['approvalPolicy']).toBeUndefined();
    } finally { await session.shutdown(); }
  });

  it('retains the vendor restoration baseline when a turn fails to start', async () => {
    const harness = createHarness({ failTurnStart: true });
    Object.assign(harness.context.binding, { permissionMode: 'yolo' });
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toThrow('turn start failed');
      expect(harness.states.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toEqual({ threadId: 'thread-new', policy: 'untrusted' });
    } finally { await harness.session.shutdown(); }
  });

  const approvalFlags = (args: readonly string[]) => args.filter((arg) => arg.includes('default_tools_approval_mode'));

  it.each([false, true])('pre-approves only the Kiki MCP server when YOLO is explicit=%s, never from ambient mode', async (explicit) => {
    const harness = createHarness({ kikiSubagents: true, permissionMode: { mode: 'yolo' } });
    if (explicit) Object.assign(harness.context.binding, { permissionMode: 'yolo' });
    try {
      await (await harness.session.run({ kind: 'prompt', prompt: 'delegate' }, { signal: new AbortController().signal })).completion;
      expect(harness.spawns).toHaveLength(1);
      expect(approvalFlags(harness.spawns[0]!)).toEqual(explicit ? ['mcp_servers.kiki-harness.default_tools_approval_mode="approve"'] : []);
      expect(harness.spawns[0]!.join(' ')).not.toMatch(/mcp_servers\.(?!kiki-harness\.)[^.=]+\.default_tools_approval_mode/);
      expect(harness.spawns[0]!.join(' ')).not.toMatch(/approval_policy|sandbox_mode|danger-full-access|bypass/);
      expect(harness.starts[0]).toMatchObject({ approvalPolicy: undefined, sandbox: undefined });
      expect(harness.prompts[0]).toMatchObject({ approvalPolicy: explicit ? 'never' : undefined,
        sandboxPolicy: undefined });
    } finally { await harness.session.shutdown(); }
  });

  it('keeps Codex asking for the Kiki MCP server outside YOLO', async () => {
    for (const mode of ['manual', 'auto'] as const) {
      const harness = createHarness({ kikiSubagents: true, permissionMode: { mode } });
      try {
        await (await harness.session.run({ kind: 'prompt', prompt: 'delegate' }, { signal: new AbortController().signal })).completion;
        expect(approvalFlags(harness.spawns[0]!)).toEqual([]);
        expect(harness.spawns[0]!.join(' ')).toContain('mcp_servers.kiki-harness.command="kiki"');
        expect(harness.prompts[0]).toMatchObject({ approvalPolicy: undefined });
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
      Object.assign(harness.context.binding, { permissionMode: 'yolo' });
      await (await harness.session.run({ kind: 'prompt', prompt: 'three' }, { signal: new AbortController().signal })).completion; await harness.session.settled();
      expect(harness.client.shutdown).toHaveBeenCalledOnce();
      expect(harness.spawns).toHaveLength(2);
      expect(approvalFlags(harness.spawns[1]!)).toHaveLength(1);
      expect(harness.resumes.at(-1)).toMatchObject({ threadId: 'thread-new', approvalPolicy: undefined });
      expect(harness.prompts.at(-1)).toMatchObject({ approvalPolicy: 'never' });
      mode.mode = 'auto';
      Object.assign(harness.context.binding, { permissionMode: undefined });
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
      ix.dispose();
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
    complete: (status = 'completed') => {
      stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: `turn-${turnIndex}`, itemId: 'message-1', delta: 'done',
      } })}\n`);
      stdout.write(`${JSON.stringify({ method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: `turn-${turnIndex}`, status },
      } })}\n`);
    },
  };
}

describe('real Codex client through execution settlement and capacity', () => {
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
      harness.ix.dispose();
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
      harness.ix.dispose();
    }
  });
});
