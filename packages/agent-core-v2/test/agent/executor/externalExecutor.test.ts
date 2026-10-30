import { AcpClientError, mapAcpSessionNotification, parseExecutorSessionRefEnvelope } from '@kiki/acp-client';
import type {
  AcpOpenSessionOptions,
  AcpOpenSessionResult,
  AcpElicitationHandler,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPlanApprovalHandler,
  AcpProcessClient,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpSessionConfigOption,
  AcpTurnHandle,
  AcpTurnRequest,
  AcpTurnResult,
  NormalizedExecutorEvent,
} from '@kiki/acp-client';
import { describe, expect, it, vi } from 'vitest';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { coldPromptFixture } from './coldPromptFixture';
import { resolveExecutionBinding } from '#/agent/profile/executionBinding';
import { attachExternalMailboxHarness } from './mailboxHarness';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';

import { buildModeOption } from '../../../../acp-server/src/config-options';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { IAgentGoalService } from '#/agent/goal/goal';
import type { GoalSnapshot } from '#/agent/goal/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import type { TodoItem } from '#/session/todo/todoItem';
import type { TodoNotes } from '#/session/todo/todoNotes';
import { appendSharedPromptField } from '#/app/promptField/builtinPromptFields';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AcpAgentExecutorProvider } from '#/agent/execution/acpAgentExecutorProvider';
import {
  AcpAgentExecutorSession,
  buildHandoff,
  resolveAcpProcessArgs,
} from '#/agent/execution/acpAgentExecutorSession';
import {
  ExecutorHintDelivery,
  ExecutorPlanUpdate,
  ExecutorRuntimeUpdate,
  ExecutorToolDisplay,
  ExecutorSessionUpdated,
  ExecutorTurnMetadata,
  externalExecutorKey,
  type ExecutorCumulativeUsage,
} from '#/agent/execution/externalExecutorOps';
import { ExternalTurnRecorder } from '#/agent/execution/externalTurnRecorder';
import { TurnPrompt, turnKey } from '#/agent/loop/turnOps';
import { AssistantDelta, ThinkingDelta } from '#/agent/loop/turnEvents';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { agentMessageMaterializationsKey } from '#/session/agentCollaboration/messageReceiptState';
import { IAgentUsageService } from '#/agent/usage/usage';
import {
  agentExecutorBindingFingerprint,
  IAgentExecutorRegistry,
  type AgentExecutorContext,
} from '#/app/agentExecutor/agentExecutor';
import type { NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { BUILTIN_AGENT_EXECUTORS } from '#/app/agentExecutor/builtinDescriptors';
import type { Event2 } from '#/app/event/event2';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { ISessionApprovalService, type ApprovalResponse } from '#/session/approval/approval';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionQuestionService, type QuestionResult } from '#/session/question/question';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IHarnessMcpService } from '#/app/agentExecutor/harnessMcp';
import { IRequestGovernance } from '#/app/requestGovernance/requestGovernance';
import { createTestAgent } from '../../harness';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

interface FakeHarnessOptions {
  readonly mode?: AcpOpenSessionResult['mode'];
  readonly events?: readonly NormalizedExecutorEvent[];
  readonly history?: readonly ContextMessage[];
  readonly todos?: readonly TodoItem[];
  readonly notes?: TodoNotes;
  readonly goal?: GoalSnapshot | null;
  readonly prior?: ReturnType<typeof stateHarness>['prior'];
  readonly approval?: () => Promise<ApprovalResponse>;
  readonly elicitation?: AcpElicitationRequest;
  readonly questionResponse?: QuestionResult;
  readonly planApproval?: Parameters<AcpPlanApprovalHandler>[0];
  readonly permissionSignal?: AbortController;
  readonly loadReplayObserved?: boolean;
  readonly permissionSurface?: boolean;
  readonly sessionConfigOptions?: readonly AcpSessionConfigOption[];
  readonly capabilities?: AcpOpenSessionResult['capabilities'];
  readonly configureFailureId?: string;
  readonly configureReadbackFailureId?: string;
  readonly permissionMode?: 'manual' | 'auto' | 'yolo';
  readonly inheritPermission?: boolean;
  readonly vendorDefaultOption?: boolean;
  readonly permissionToolCall?: Parameters<AcpPermissionHandler>[0]['toolCall'];
  readonly permissionRequestMeta?: Record<string, unknown>;
  readonly permissionGate?: IAgentPermissionGate['authorize'];
  readonly permissionMapping?: AgentExecutorContext['descriptor']['permissionModeMapping'] | null;
  readonly profileDelivery?: AgentExecutorContext['descriptor']['profileDelivery'];
  readonly modelConfigId?: string;
  readonly thoughtConfigId?: string;
  readonly completionUsage?: AcpTurnResult['response']['usage'];
  readonly executorId?: string;
  readonly executorVersion?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly providerName?: string;
  readonly modelAlias?: string;
  readonly unpinModel?: boolean;
  readonly thinkingEffort?: string;
  readonly modelBinding?: 'session_config' | 'argv';
  readonly modelArgs?: readonly string[];
  readonly args?: readonly string[];
  readonly priorBindingFingerprint?: string;
  readonly deferTurnCompletion?: boolean;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly supportsMcp?: boolean;
  readonly hostPermissionReceipt?: (input: AcpOpenSessionOptions) => Readonly<Record<string, unknown>> | undefined;
  readonly client?: AcpProcessClient;
  readonly clientState?: 'cold' | 'ready' | 'broken';
  readonly permission?: AgentExecutorContext['descriptor']['permission'];
}

function asyncEvents(events: readonly NormalizedExecutorEvent[]): AsyncIterable<NormalizedExecutorEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function configOptions(permissionSurface = true, autoApprove = true): AcpSessionConfigOption[] {
  const options: AcpSessionConfigOption[] = [
    {
      id: 'model-id',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'ambient-model',
      options: [
        { value: 'model-a', name: 'Model A' },
        { value: 'ambient-model', name: 'Ambient' },
      ],
    },
    {
      id: 'thought-id',
      name: 'Thought',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
  if (permissionSurface) {
    options.push({
      id: 'auto_approve',
      name: 'Auto approve',
      category: 'mode',
      type: 'boolean',
      currentValue: autoApprove,
    });
  }
  return options;
}

function stateHarness(prior: {
  readonly executorId?: string;
  readonly descriptorRevision?: string;
  readonly sessionRef?: {
    readonly executorId: string;
    readonly version: number;
    readonly ref: Readonly<Record<string, unknown>>;
  };
  readonly sessionEpoch?: number;
  readonly profileDeliveredSessionId?: string;
  readonly profileDelivery?: 'native' | 'first_prompt_preamble' | 'system_prompt_override';
  readonly lastCumulativeUsage?: ExecutorCumulativeUsage;
} = {}) {
  const values = new Map<unknown, unknown>([
    [turnKey, { nextTurnId: 4, cancelledTurnIds: [] }],
    [externalExecutorKey, prior],
    [agentMessageMaterializationsKey, agentMessageMaterializationsKey.initial()],
  ]);
  const state = {
    _serviceBrand: undefined,
    contributeState: (key: { initial(): unknown }) => {
      if (!values.has(key)) values.set(key, key.initial());
      return { dispose: () => {} };
    },
    get: (key: unknown) => values.get(key),
    set: (key: unknown, value: unknown) => values.set(key, value),
  } as unknown as IAgentStateService;
  return { state, values, prior };
}

function negotiatedRegistry() {
  const caps = new Map<string, NegotiatedExecutorCapabilities>();
  return {
    recordNegotiated: vi.fn((id: string, version: string | undefined, capabilities: NegotiatedExecutorCapabilities) => {
      const key = `${id}\0${version ?? ''}`;
      caps.set(key, { ...caps.get(key), ...capabilities });
    }),
    negotiated: (id: string, version: string | undefined) => caps.get(`${id}\0${version ?? ''}`),
  };
}

function createHarness(options: FakeHarnessOptions = {}) {
  const events: Event2[] = [];
  const loopEvents: unknown[] = [];
  const appendedMessages: ContextMessage[] = [];
  const starts: AcpTurnRequest[] = [];
  const opens: AcpOpenSessionOptions[] = [];
  const selections: Array<{ configId: string; value: string | boolean }> = [];
  const permissionDecisions: AcpPermissionDecision[] = [];
  const elicitationDecisions: AcpElicitationResponse[] = [];
  const planDecisions: Awaited<ReturnType<AcpPlanApprovalHandler>>[] = [];
  const question = { _serviceBrand: undefined, request: vi.fn(async () => options.questionResponse ?? null) };
  const approvalRequests: unknown[] = [];
  const state = stateHarness(options.prior);
  const wire = {
    _serviceBrand: undefined,
    flush: vi.fn(async () => {}),
  } as unknown as IWireService;
  const dispatcher = {
    _serviceBrand: undefined,
    flush: async () => wire.flush(),
    dispatch: async (event: Event2) => {
      events.push(event);
      if (event instanceof TurnPrompt) {
        state.values.set(turnKey, { nextTurnId: event.turnId! + 1, cancelledTurnIds: [] });
      }
      if (event instanceof ExecutorSessionUpdated) {
        state.values.set(externalExecutorKey, {
          executionGeneration: event.executionGeneration,
          executorId: event.executorId,
          descriptorRevision: event.descriptorRevision,
          bindingFingerprint: event.bindingFingerprint,
          sessionRef: event.sessionRef,
          sessionEpoch: event.sessionEpoch,
          profileDeliveredSessionId: event.profileDeliveredSessionId,
          profileDelivery: event.profileDelivery,
        });
      }
    },
  } as unknown as IEventDispatcher;
  const contextMemory = {
    _serviceBrand: undefined,
    get: () => options.history ?? [],
    append: (...messages: readonly ContextMessage[]) => appendedMessages.push(...messages),
    appendManaged: (message: ContextMessage, _delivery: unknown) => appendedMessages.push(message),
    appendObservable: (message: ContextMessage) => appendedMessages.push(message),
    appendLoopEvent: (event: unknown) => loopEvents.push(event),
  } as unknown as IAgentContextMemoryService;
  const approval = {
    _serviceBrand: undefined,
    request: async (request: unknown) => {
      approvalRequests.push(request);
      if (options.approval === undefined) throw new Error('no approval consumer');
      return options.approval();
    },
  } as unknown as ISessionApprovalService;
  const pendingTurns = new Set<number>();
  const interaction = {
    _serviceBrand: undefined,
    cancelPendingForTurn: vi.fn((turnId: number) => {
      pendingTurns.delete(turnId);
    }),
  } as unknown as ISessionInteractionService;
  const processService = { spawn: vi.fn() };
  const runtimeLease = {
    runtime: {
      process: processService,
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
    workDir: 'C:\\workspace',
    additionalDirs: ['C:\\shared'],
  } as unknown as ISessionWorkspaceContext;
  const permissionMode = {
    _serviceBrand: undefined,
    mode: options.permissionMode ?? 'manual',
    externalOverride: options.inheritPermission === true ? undefined : options.permissionMode,
    setMode: vi.fn(),
  } as unknown as IAgentPermissionModeService;
  const usageRecords: Parameters<IAgentUsageService['record']>[] = [];
  const usage = {
    _serviceBrand: undefined,
    record: (...args: Parameters<IAgentUsageService['record']>) => { usageRecords.push(args); },
    status: () => ({}),
    onDidRecord: () => ({ dispose: () => {} }),
  } as IAgentUsageService;
  const modelCatalog = {
    get: () => {
      if (options.providerName === undefined) throw new Error('model is external-only');
      return { providerName: options.providerName } as Model;
    },
  } as unknown as IModelCatalog;
  const mcpHandle = {
    ready: Promise.resolve(),
    connectionManager: {
      list: () => Object.entries(options.mcpServers ?? {}).map(([name, config]) => ({
        name, status: 'connected', transport: config.transport, toolCount: 0,
      })),
      configOf: (name: string) => options.mcpServers?.[name],
    },
  } as unknown as ISessionMcpHandle;
  const services = new Map<unknown, unknown>([
    [ISessionContext, { sessionId: 'session-fixture' }],
    [IAgentScopeContext, { parentAgentId: options.parentAgentId }],
    [IHarnessMcpService, { acquire: vi.fn(async () => ({ server: {
      name: 'kiki-harness', command: 'fixture-kiki', args: [], env: [],
    }, dispose() {} })) }],
    [IAgentStateService, state.state],
    [IModelCatalog, modelCatalog],
    [IAgentUsageService, usage],
    [IEventDispatcher, dispatcher],
    [IWireService, wire],
    [IAgentContextMemoryService, contextMemory],
    [ISessionApprovalService, approval],
    [ISessionQuestionService, question],
    [ISessionInteractionService, interaction],
    [ISessionMcpHandle, mcpHandle],
    [IAgentRuntimeService, runtime],
    [ISessionWorkspaceContext, workspace],
    [IAgentPermissionModeService, permissionMode],
    [IAgentPermissionRulesService, { rules: [] }],
    [IAgentPermissionGate, { authorize: options.permissionGate ?? (async (context: import('#/agent/toolExecutor/toolHooks').ResolvedToolExecutionHookContext) => {
      if (permissionMode.mode !== 'manual') return undefined;
      const response = await approval.request({ agentId: options.agentId ?? 'external-agent', turnId: context.turnId,
        toolCallId: context.toolCall.id, toolName: context.toolCall.name, action: context.toolCall.name,
        display: context.execution.display ?? { kind: 'external_permission', summary: context.toolCall.name, options: [] } });
      const selected = context.execution.display?.kind === 'external_permission'
        ? context.execution.display.options.find((option) => option.id === response.selectedOptionId) : undefined;
      return response.decision === 'approved' && selected?.kind.startsWith('allow_') ? undefined
        : { permissionDecision: response.decision === 'rejected' && selected?.kind.startsWith('reject_') ? 'rejected' : 'cancelled',
          veto: { isError: true, output: 'Not approved' } };
    }) }],
    [IAgentExecutorRegistry, negotiatedRegistry()],
    [ISessionMetadata, { read: async () => ({ agents: {} }), getAgentExecutor: async () => undefined, registerAgent: vi.fn(), updateAgent: vi.fn(async () => {}) }],
  ]);
  let permissionHandler: AcpPermissionHandler | undefined;
  let elicitationHandler: AcpElicitationHandler | undefined;
  let planHandler: AcpPlanApprovalHandler | undefined;
  let configured = options.sessionConfigOptions === undefined
    ? configOptions(options.permissionSurface !== false)
    : [...options.sessionConfigOptions];
  const openResult = (): AcpOpenSessionResult => ({
    sessionId: 'remote-2',
    mode: options.mode ?? 'new',
    initialize: {} as AcpOpenSessionResult['initialize'],
    capabilities: options.capabilities ?? {},
    configOptions: configured,
    sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
    sessionRequestMeta: opens.at(-1)?.sessionMeta === undefined ? undefined : JSON.parse(JSON.stringify(opens.at(-1)!.sessionMeta)),
    sessionResponseMeta: opens.length === 0 ? undefined : options.hostPermissionReceipt?.(opens.at(-1)!),
    loadReplayObserved: options.loadReplayObserved ?? false,
    quarantinedUpdateCount: options.loadReplayObserved === true ? 2 : 0,
  });
  let resolveTurnCompletion: ((result: AcpTurnResult) => void) | undefined;
  const turnCancel = vi.fn(async () => {
    resolveTurnCompletion?.({
      response: { stopReason: 'cancelled' },
      session: openResult(),
      stderrTail: '',
    });
    return true;
  });
  const client = {
    status: () => ({ state: options.clientState ?? 'ready' as const, sessionId: 'remote-2' }),
    openSession: async (input: AcpOpenSessionOptions) => {
      opens.push(input);
      return openResult();
    },
    configureSession: async (input: {
      readonly configOptions?: readonly { configId: string; value: string | boolean }[];
    }) => {
      for (const selection of input.configOptions ?? []) {
        if (selection.configId === options.configureFailureId) {
          throw new Error('set_config_option failed');
        }
        selections.push(selection);
        configured = configured.map((option) =>
          option.id === selection.configId && selection.configId !== options.configureReadbackFailureId
            ? { ...option, currentValue: selection.value } as AcpSessionConfigOption
            : option,
        );
      }
      return openResult();
    },
    startTurn: async (request: AcpTurnRequest): Promise<AcpTurnHandle<NormalizedExecutorEvent>> => {
      starts.push(request);
      if (permissionHandler !== undefined) {
        const signal = options.permissionSignal?.signal ?? request.signal;
        const decision = await permissionHandler(
          {
            sessionId: 'remote-2',
            _meta: options.permissionRequestMeta,
            toolCall: options.permissionToolCall ?? {
              toolCallId: 'permission-tool',
              title: 'Apply patch',
              status: 'pending',
              rawInput: { path: 'src/a.ts' },
            },
            options: [
              ...options.vendorDefaultOption === true ? [{ optionId: 'kiki.vendor_default', name: 'Use vendor permissions', kind: 'allow_once' as const }] : [],
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
          {
            signal,
            options: [
              ...options.vendorDefaultOption === true ? [{ optionId: 'kiki.vendor_default', name: 'Use vendor permissions', kind: 'allow_once' as const }] : [],
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        );
        permissionDecisions.push(decision);
      }
      if (options.elicitation !== undefined) elicitationDecisions.push(await elicitationHandler!(options.elicitation, { signal: request.signal }));
      if (options.planApproval !== undefined) planDecisions.push(await planHandler!(options.planApproval, { signal: request.signal }));
      const result: AcpTurnResult = {
        response: { stopReason: 'end_turn', usage: options.completionUsage },
        session: openResult(),
        stderrTail: '',
      };
      const completion = options.deferTurnCompletion === true
        ? new Promise<AcpTurnResult>((resolve) => { resolveTurnCompletion = resolve; })
        : Promise.resolve(result);
      return {
        events: asyncEvents(options.events ?? []),
        completion,
        cancel: turnCancel,
      };
    },
    cancel: async () => true,
    shutdown: vi.fn(async () => {}),
  };
  const executorContext: AgentExecutorContext = {
    agent: {
      id: options.agentId ?? 'external-agent',
      accessor: {
        get: (id) => {
          if (!services.has(id)) throw new Error(`Missing service ${String(id)}`);
          return services.get(id) as never;
        },
      },
    },
    descriptor: {
      id: options.executorId ?? 'example-acp',
      protocol: 'acp-v1',
      command: 'example-acp',
      args: options.args ?? [],
      modelBinding: options.modelBinding ?? 'session_config',
      permission: options.permission,
      modelArgs: options.modelArgs,
      modelConfigCategory: 'model',
      modelConfigId: options.modelConfigId,
      thoughtConfigCategory: 'thought_level',
      thoughtConfigId: options.thoughtConfigId,
      permissionModeMapping: options.permissionMapping === null
        ? undefined
        : options.permissionMapping ?? {
            configId: 'auto_approve',
            manual: false,
            auto: false,
            yolo: true,
          },
      profileDelivery: options.profileDelivery,
      supportsMcp: options.supportsMcp,
      version: options.executorVersion,
      revision: 'r1',
    },
    binding: {
      modelAlias: options.unpinModel === true ? undefined : options.modelAlias ?? 'model-a',
      thinkingLevel: options.thinkingEffort ?? 'high',
      thinkingEffortExplicit: options.thinkingEffort !== undefined || options.unpinModel !== true,
      systemPrompt: 'Frozen profile',
      executorPrompt: options.profileDelivery === 'system_prompt_override'
        ? { delivery: 'replace', include: [] } : undefined,
      executorId: options.executorId ?? 'example-acp',
      executorProtocol: 'acp-v1',
      executorDescriptorRevision: 'r1',
    },
  };
  const priorState = state.values.get(externalExecutorKey) as Record<string, unknown>;
  if (priorState['sessionRef'] !== undefined) {
    state.values.set(externalExecutorKey, {
      ...priorState,
      bindingFingerprint:
        options.priorBindingFingerprint ??
        agentExecutorBindingFingerprint(executorContext.binding),
    });
  }
  const createSession = (context: AgentExecutorContext) => new AcpAgentExecutorSession(
    context,
    (_process, handler, elicitation, planApproval) => {
      permissionHandler = handler;
      elicitationHandler = elicitation;
      planHandler = planApproval;
      return options.client ?? client;
    },
  );
  let session: AcpAgentExecutorSession | undefined;
  const getSession = (): AcpAgentExecutorSession => session ??= createSession(executorContext);
  return {
    get session(): AcpAgentExecutorSession {
      return getSession();
    },
    createSession,
    executorContext,
    state: state.state,
    events,
    loopEvents,
    appendedMessages,
    starts,
    opens,
    selections,
    permissionDecisions,
    elicitationDecisions,
    planDecisions,
    question,
    approvalRequests,
    interaction,
    pendingTurns,
    runtime,
    runtimeLease,
    workspace,
    mcpHandle,
    permissionMode,
    usage,
    modelCatalog,
    contextMemory,
    approval,
    dispatcher,
    wire,
    client,
    turnCancel,
    usageRecords,
  };
}

export function createExecutionHarness(options: FakeHarnessOptions = {}): {
  ix: TestInstantiationService;
  execution: AgentExecutionService;
  starts: AcpTurnRequest[];
  events: Event2[];
  pendingTurns: Set<number>;
  interaction: ISessionInteractionService;
  client: {
    openSession(options: AcpOpenSessionOptions): Promise<AcpOpenSessionResult>;
    shutdown(): Promise<void>;
  };
  runtimeLease: { dispose(): void };
  turnCancel(): Promise<boolean>;
} {
  const harness = createHarness({ ...options, deferTurnCompletion: true });
  const ix = new TestInstantiationService();
  const agentId = harness.executorContext.agent.id;
  ix.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
  ix.stub(ISessionContext, { sessionId: 'session-fixture' });
  ix.stub(IRequestGovernance, { acquireAgent: async () => ({ release() {} }) });
  ix.set(IAgentContextMemoryService, harness.contextMemory);
  ix.stub(IAgentContextInjectorService, { reconcileAllAtSafeBoundary: async () => {} });
  ix.stub(ISessionTodoService, {
    getTodos: () => options.todos ?? [],
    getNotes: () => ({ notes: options.notes }),
  });
  ix.stub(IAgentGoalService, { getGoal: () => ({ goal: options.goal ?? null }) });
  ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
  ix.set(IAgentExecutorRegistry, {
    resolveExecutable: async () => ({
      descriptor: harness.executorContext.descriptor,
      options: {},
      provider: { create: harness.createSession },
    }),
  } as unknown as IAgentExecutorRegistry);
  ix.stub(ISessionMetadata, { read: async () => ({ id: 's1', createdAt: 1, updatedAt: 1, archived: false, agents: {} }), getAgentExecutor: async () => undefined, registerAgent: vi.fn(), updateAgent: vi.fn(async () => {}) });
  ix.set(IAgentPermissionModeService, harness.permissionMode);
  ix.stub(IAgentPermissionRulesService, { rules: [] });
  const resumeModel = harness.executorContext.binding.modelAlias ?? 'model-a';
  const resumeThinking = harness.executorContext.binding.thinkingLevel;
  ix.set(IAgentProfileService, {
    _serviceBrand: undefined,
    data: () => harness.executorContext.binding,
    preparePromptConfiguration: async () => false,
    getSystemPrompt: () => appendSharedPromptField(harness.executorContext.binding.systemPrompt, { values: { 'system.shared': 'ALL_EXECUTORS_SHARED' }, fields: [] }),
    getModel: () => resumeModel,
    getEffectiveThinkingLevel: () => resumeThinking,
    republishStatus: () => {},
    publishBindingAdvisories: () => {},
    syncBindingMetadata: async () => {},
    prepareResumeBinding: async () => ({
      model: resumeModel,
      thinking: resumeThinking,
      config: { modelAlias: resumeModel, thinkingEffort: resumeThinking },
      maxContextTokens: undefined,
      reservedTokens: undefined,
      assertCurrent: () => {},
      syncMetadata: async () => {},
    }),
  } as unknown as IAgentProfileService);
  ix.set(IAgentRuntimeService, harness.runtime);
  ix.set(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId,
    scope: (subKey) => subKey === undefined ? agentId : `${agentId}/${subKey}`,
  });
  ix.set(IAgentStateService, harness.state);
  ix.set(IAgentUsageService, harness.usage);
  ix.set(IEventDispatcher, harness.dispatcher);
  ix.set(IModelCatalog, harness.modelCatalog);
  ix.set(IWireService, harness.wire);
  ix.set(ISessionApprovalService, harness.approval);
  ix.set(ISessionInteractionService, harness.interaction);
  ix.set(ISessionMcpHandle, harness.mcpHandle);
  ix.set(ISessionWorkspaceContext, harness.workspace);
  ix.provide(IAgentLoopService, {} as IAgentLoopService);
  ix.stub(IAgentPromptService, {});
  const execution = ix.get(IAgentExecutionService) as AgentExecutionService;
  return {
    ix,
    execution,
    starts: harness.starts,
    events: harness.events,
    pendingTurns: harness.pendingTurns,
    interaction: harness.interaction,
    client: harness.client,
    runtimeLease: harness.runtimeLease,
    turnCancel: harness.turnCancel,
  };
}

const mappingEvents: NormalizedExecutorEvent[] = [
  {
    type: 'message.delta',
    role: 'assistant',
    content: { type: 'text', text: 'answer' },
  },
  {
    type: 'thought.delta',
    content: { type: 'text', text: 'thinking' },
  },
  {
    type: 'tool.call',
    toolCallId: 'tool-1',
    title: 'Run tool',
    status: 'pending',
  },
  {
    type: 'tool.update',
    toolCallId: 'tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'summary' } }],
  },
  {
    type: 'plan.update',
    plan: { entries: [{ content: 'ship', status: 'in_progress' }] },
    unstable: true,
  },
  { type: 'commands.update', commands: [{ name: 'review' }] },
  { type: 'mode.update', currentModeId: 'default' },
  { type: 'config.update', configOptions: [] },
  { type: 'session.info', title: 'External child' },
  { type: 'usage', used: 12, size: 100 },
  { type: 'unknown', updateType: 'vendor.future' },
];

describe('ACP external executor', () => {
  it.each(['openSession', 'configureSession', 'startTurn'] as const)('records a typed authentication requirement from %s without marking sign-out', async (method) => {
    const harness = createHarness();
    const error = new AcpClientError('executor.authentication_required', 'Sign in');
    vi.spyOn(harness.client, method).mockRejectedValue(error);
    await expect(harness.session.run({ kind: 'prompt', prompt: 'neutral fixture' }, { signal: new AbortController().signal })).rejects.toBe(error);
    expect(harness.events.find((event) => event.type === 'executor.auth.observed')).toMatchObject({
      status: 'required', scope: 'session', source: 'acp.authentication_required', executor_id: 'example-acp', cwd: 'C:\\workspace',
    });
    expect(harness.starts).toHaveLength(0);
    await harness.session.shutdown();
  });

  it('cancels the active remote prompt when recording fails instead of leaving execution running', async () => {
    const harness = createHarness({
      deferTurnCompletion: true,
      events: [{ type: 'message.delta', role: 'assistant', content: { type: 'text', text: 'answer' } }],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const dispatch = harness.dispatcher.dispatch.bind(harness.dispatcher);
    harness.dispatcher.dispatch = async (event) => {
      if (event instanceof AssistantDelta) throw new Error('fixture recording failed');
      return dispatch(event);
    };
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      await expect(run.completion).rejects.toThrow('fixture recording failed');
      expect(await run.turn.result).toMatchObject({ type: 'failed' });
      await harness.session.settled();
      expect(harness.turnCancel).toHaveBeenCalledOnce();
      expect(harness.session.status().state).toBe('idle');
    } finally { await harness.session.shutdown(); }
  });

  it('keeps permission overrides and clear within the same execution context', () => {
    const first = resolveExecutionBinding({ executor: 'example-acp', overrides: { permission_mode: 'yolo' } }, undefined, undefined, undefined);
    const next = resolveExecutionBinding({ executor: 'example-acp', overrides: { permission_mode: 'auto' } }, undefined, undefined, first);
    const cleared = resolveExecutionBinding({ executor: 'example-acp', overrides: { permission_mode: null } }, undefined, undefined, next);
    expect([next.generation, cleared.generation]).toEqual([first.generation, first.generation]);
    expect(cleared.effective.permission_mode).toBeUndefined();
    expect(cleared.sources['permission_mode']).toBe('harness-default');
    const bind = (execution: typeof first) => ({ systemPrompt: '', thinkingLevel: 'off', execution });
    expect(agentExecutorBindingFingerprint(bind(first))).toBe(agentExecutorBindingFingerprint(bind(cleared)));
    expect(resolveExecutionBinding({ executor: 'example-acp', overrides: { model: 'model-other' } }, undefined, undefined, cleared).generation)
      .toBe(first.generation + 1);
  });

  it('keeps old reminders and previously queued mail out of a bare user turn after delegation is explicitly disabled', async () => {
    const harness = createExecutionHarness({ unpinModel: true, thinkingEffort: 'off',
      history: [{ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'OLD_CONTEXT' }], origin: { kind: 'injection', variant: 'goal_state' } }],
      todos: [{ title: 'OLD_TODO', status: 'pending' }],
    });
    const profile = harness.ix.get(IAgentProfileService);
    const original = profile.data();
    const execution = resolveExecutionBinding({ executor: original.executorId! }, undefined, undefined, undefined);
    const binding = { ...original, execution, modelAlias: undefined, thinkingLevel: 'off' as const, systemPrompt: '', kikiContext: [], allowKikiSubagents: false };
    const data = vi.spyOn(profile, 'data').mockReturnValue(binding);
    const reconcile = vi.spyOn(harness.ix.get(IAgentContextInjectorService), 'reconcileAllAtSafeBoundary');
    const mailbox = attachExternalMailboxHarness(harness.ix, 'external-agent');
    try {
      const accepted = await mailbox.messaging.send({ sourceAgentId: 'main', sourceTaskName: 'root', targetAgentId: 'external-agent',
        targetTaskName: 'external-agent', content: 'OLD_MAIL', idempotencyKey: 'old-mail', waitForRunningDelivery: true });
      expect(accepted.delivery).toBe('queued');
      data.mockReturnValue({ ...binding, execution: resolveExecutionBinding({
        executor: original.executorId!, overrides: { allow_kiki_subagents: false },
      }, undefined, undefined, execution) });
      await expect(mailbox.messaging.send({ sourceAgentId: 'main', sourceTaskName: 'root', targetAgentId: 'external-agent',
        targetTaskName: 'external-agent', content: 'NEW_MAIL', idempotencyKey: 'new-mail', waitForRunningDelivery: true }))
        .rejects.toThrow(/allow_kiki_subagents is false/);
      await harness.execution.run({ kind: 'prompt', prompt: 'ONLY_NEW_USER' }, { signal: new AbortController().signal });
      expect(harness.starts[0]?.prompt).toBe('ONLY_NEW_USER');
      expect(reconcile).not.toHaveBeenCalled();
      expect(mailbox.delivered()).toBe(false);
    } finally { await mailbox.dispose(); await harness.execution.shutdown(); await harness.ix.dispose(); }
  });


  it('keeps direct ACP factory payload bare across a durable generation boundary', async () => {
    const harness = createHarness({ unpinModel: true, thinkingEffort: 'off',
      mcpServers: { relay: { transport: 'stdio', command: 'node' } },
      history: [{ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'OLD_KIKI_HISTORY' }] }],
      prior: { executorId: 'old-executor', descriptorRevision: 'old-revision', sessionEpoch: 3,
        sessionRef: { executorId: 'old-executor', version: 1, ref: { sessionId: 'old-session' } } },
    });
    const execution = resolveExecutionBinding({ executor: 'example-acp' }, undefined, undefined, undefined);
    const context = { ...harness.executorContext, binding: { ...harness.executorContext.binding, execution,
      modelAlias: undefined, thinkingLevel: 'off', systemPrompt: '', kikiContext: [], allowKikiSubagents: false } };
    const session = harness.createSession(context);
    try {
      const handle = await session.run({ kind: 'prompt', prompt: 'ONLY_NEW_USER' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.opens[0]).toMatchObject({ cwd: harness.workspace.workDir, mcpServers: [] });
      expect(harness.opens[0]?.sessionRef).toBeUndefined();
      expect(harness.opens[0]?.systemPromptOverride).toBeUndefined();
      expect(harness.selections).toEqual([]);
      expect(harness.starts[0]?.prompt).toBe('ONLY_NEW_USER');
      expect(harness.state.get(externalExecutorKey)).toMatchObject({ executionGeneration: 1, sessionEpoch: 4 });
      const persistedRef = harness.state.get(externalExecutorKey).sessionRef;
      expect(() => parseExecutorSessionRefEnvelope(persistedRef)).not.toThrow();
      expect(persistedRef?.ref).not.toHaveProperty('localSource');
      await session.shutdown();
      if (persistedRef === undefined) throw new Error('Expected saved remote reference');
      harness.state.set(externalExecutorKey, { ...harness.state.get(externalExecutorKey),
        sessionRef: { ...persistedRef, ref: { ...persistedRef.ref, localSource: undefined } } });
      const cold = harness.createSession(context);
      try {
        const next = await cold.run({ kind: 'prompt', prompt: 'COLD_USER' }, { signal: new AbortController().signal });
        await next.completion;
        expect(harness.opens[1]?.sessionRef).toMatchObject({ ref: { sessionId: 'remote-2' } });
        expect(() => parseExecutorSessionRefEnvelope(harness.opens[1]?.sessionRef)).not.toThrow();
        expect(harness.starts[1]?.prompt).toBe('COLD_USER');
      } finally { await cold.shutdown(); }
    } finally { await session.shutdown(); }
  });

  it('sends only explicitly selected ACP controls without adding a Kiki preamble', async () => {
    const harness = createHarness();
    const execution = resolveExecutionBinding({ executor: 'example-acp', overrides: {
      model: 'model-a', thinking: 'high', permission_mode: 'auto',
    } }, undefined, undefined, undefined);
    const session = harness.createSession({ ...harness.executorContext, binding: {
      ...harness.executorContext.binding, execution, systemPrompt: '', kikiContext: [], allowKikiSubagents: false,
    } });
    try {
      const handle = await session.run({ kind: 'prompt', prompt: 'ONLY_USER' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.selections).toEqual([
        { configId: 'model-id', value: 'model-a' }, { configId: 'thought-id', value: 'high' },
        { configId: 'auto_approve', value: false },
      ]);
      expect(harness.starts[0]?.prompt).toBe('ONLY_USER');
    } finally { await session.shutdown(); }
  });

  it.each([undefined, 'engine-default', 'specialist'])('negotiates native agent %s independently of the executor name', async (nativeAgent) => {
    const choices: AcpSessionConfigOption[] = [{ id: 'native-choice', name: 'Native agent', category: 'native_agent', type: 'select',
      currentValue: 'vendor-main', options: [{ value: 'specialist', name: 'Specialist' }] }];
    const harness = createHarness({ executorId: 'neutral-harness', inheritPermission: true, unpinModel: true, thinkingEffort: 'off', sessionConfigOptions: choices });
    const initial = resolveExecutionBinding({ executor: 'neutral-harness' }, undefined, undefined, undefined);
    const execution = resolveExecutionBinding({ executor: 'neutral-harness', overrides: { native_agent: nativeAgent } }, undefined, undefined, initial);
    harness.state.set(externalExecutorKey, { executionGeneration: initial.generation, executorId: 'neutral-harness', descriptorRevision: harness.executorContext.descriptor.revision,
      sessionRef: { executorId: 'neutral-harness', version: 1, ref: { sessionId: 'previous-native-agent' } } });
    const session = harness.createSession({ ...harness.executorContext, binding: { ...harness.executorContext.binding, execution, systemPrompt: '' } });
    try {
      const handle = await session.run({ kind: 'prompt', prompt: 'Neutral user input' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.selections).toEqual(nativeAgent === 'specialist' ? [{ configId: 'native-choice', value: nativeAgent }] : []);
      if (nativeAgent !== undefined) expect(harness.opens[0]?.sessionRef).toBeUndefined();
      expect(harness.starts[0]?.prompt).toBe('Neutral user input');
    } finally { await session.shutdown(); }
  });

  it('rejects a native agent absent from exact negotiation before delivering a user turn', async () => {
    const harness = createHarness({ inheritPermission: true, unpinModel: true, thinkingEffort: 'off', sessionConfigOptions: [] });
    const execution = resolveExecutionBinding({ executor: 'example-acp', overrides: { native_agent: 'specialist' } }, undefined, undefined, undefined);
    const session = harness.createSession({ ...harness.executorContext, binding: { ...harness.executorContext.binding, execution } });
    try {
      await expect(session.run({ kind: 'prompt', prompt: 'must not launch' }, { signal: new AbortController().signal })).rejects.toThrow('native agent selection is unsupported');
      expect(harness.starts).toEqual([]);
      expect(harness.selections).toEqual([]);
    } finally { await session.shutdown(); }
  });

  it.each(['0.37.0', '0.39.0', undefined])('forwards MCP to Kimi independently of its probed version %s', async (executorVersion) => {
    const harness = createHarness({
      executorId: 'kimi-acp', executorVersion, parentAgentId: 'parent-fixture',
      supportsMcp: BUILTIN_AGENT_EXECUTORS['kimi-acp']!.supportsMcp,
      mcpServers: { relay: { transport: 'stdio', command: 'node', args: ['relay.js'] } },
      thinkingEffort: 'off', unpinModel: true,
    });
    await harness.session.run({ kind: 'prompt', prompt: 'Hello' }, { signal: new AbortController().signal });
    expect(harness.opens[0]?.mcpServers).toEqual([
      { name: 'kiki-harness', command: 'fixture-kiki', args: [], env: [] },
    ]);
    await harness.session.shutdown();
  });

  it('passes session MCP servers to the engine and honors the descriptor opt-out', async () => {
    const config = { relay: { transport: 'stdio' as const, command: 'node', args: ['relay.js'] } };
    const forwarded = createHarness({ mcpServers: config, supportsMcp: true, thinkingEffort: 'off', unpinModel: true });
    await forwarded.session.run({ kind: 'prompt', prompt: 'Hello' }, { signal: new AbortController().signal });
    expect(forwarded.opens[0]?.mcpServers).toEqual([
      { name: 'relay', command: 'node', args: ['relay.js'], env: [] },
    ]);
    await forwarded.session.shutdown();

    const optedOut = createHarness({ mcpServers: config, supportsMcp: false, thinkingEffort: 'off', unpinModel: true });
    await optedOut.session.run({ kind: 'prompt', prompt: 'Hello' }, { signal: new AbortController().signal });
    expect(optedOut.opens[0]?.mcpServers).toEqual([]);
    await optedOut.session.shutdown();
  });

  it('opens ACP mcpServers with the Kiki bridge only when injection is on', async () => {
    const offExecution = resolveExecutionBinding({ executor: 'example-acp', overrides: {
      kiki_context: ['memory'], allow_kiki_subagents: true,
    } }, { inject_kiki_mcp: false, executor_prompt: { include: ['memory_snapshot'] } }, undefined, undefined);
    const off = createHarness({ supportsMcp: true, thinkingEffort: 'off', unpinModel: true });
    const offSession = off.createSession({ ...off.executorContext, binding: {
      ...off.executorContext.binding, execution: offExecution, systemPrompt: '',
    } });
    try {
      await (await offSession.run({ kind: 'prompt', prompt: 'OFF' }, { signal: new AbortController().signal })).completion;
      expect(off.opens[0]?.mcpServers).toEqual([]);
      expect(offExecution.effective).toMatchObject({ kiki_context: ['memory'], allow_kiki_subagents: true, inject_kiki_mcp: false });
    } finally { await offSession.shutdown(); }

    const onExecution = resolveExecutionBinding({ executor: 'example-acp' }, { inject_kiki_mcp: true }, undefined, undefined);
    const on = createHarness({ supportsMcp: true, thinkingEffort: 'off', unpinModel: true });
    const onSession = on.createSession({ ...on.executorContext, binding: {
      ...on.executorContext.binding, execution: onExecution, systemPrompt: '', kikiContext: [], allowKikiSubagents: false,
    } });
    try {
      await (await onSession.run({ kind: 'prompt', prompt: 'ON' }, { signal: new AbortController().signal })).completion;
      expect(on.opens[0]?.mcpServers).toEqual([{ name: 'kiki-harness', command: 'fixture-kiki', args: [], env: [] }]);
      expect(onExecution.effective.kiki_context).toEqual([]);
    } finally { await onSession.shutdown(); }
  });

  it.each([
    ['unknown key', { typo: true }],
    ['approval bypass key', { always_approve: true }],
    ['wrong value type', { mode: { unsafe: true } }],
  ])('rejects %s in closed executor options', (_name, options) => {
    expect(() => AcpAgentExecutorProvider.validateOptions(options)).toThrow();
  });

  it('accepts an empty closed executor options mapping', () => {
    expect(AcpAgentExecutorProvider.validateOptions({})).toEqual({});
  });

  it('records Claude ACP negotiated model metadata as a runtime fact', async () => {
    const harness = createHarness({ executorId: 'claude-acp', modelAlias: 'model-a' });
    const handle = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await handle.completion;

    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'executor.runtime.update',
      kind: 'session',
      value: { meta: { source: 'claude-acp', actualModel: 'model-a', agentVersion: undefined } },
    }));
    await harness.session.shutdown();
  });

  it('keeps the generic recorder free of ACP-specific losses and durable wording', async () => {
    const loopEvents: unknown[] = [];
    const dispatcher = {
      _serviceBrand: undefined,
      dispatch: async () => {},
    } as unknown as IEventDispatcher;
    const wire = {
      _serviceBrand: undefined,
      flush: async () => {},
    } as unknown as IWireService;
    const contextMemory = {
      _serviceBrand: undefined,
      get: () => [],
      append: () => {},
      appendManaged: () => {},
      appendLoopEvent: (event: unknown) => loopEvents.push(event),
    } as unknown as IAgentContextMemoryService;
    const usage = {
      _serviceBrand: undefined,
      record: () => {},
      status: () => ({}),
      onDidRecord: () => ({ dispose: () => {} }),
    } as IAgentUsageService;
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, dispatcher],
      [IWireService, wire],
      [IAgentContextMemoryService, contextMemory],
      [IAgentUsageService, usage],
    ]);
    const recorder = new ExternalTurnRecorder(
      {
        id: 'generic-agent',
        accessor: { get: (id) => services.get(id) as never },
      },
      1,
      'generic-session',
      {
        executorId: 'generic-executor',
        protocol: 'vendor-v2',
        model: 'generic-model',
        modelAlias: 'generic-model',
        resumeMode: 'new',
        profileDelivery: 'native',
      },
    );

    await recorder.begin('work', { kind: 'user' });
    await recorder.record({
      type: 'tool.call',
      toolCallId: 'tool-1',
      title: 'Generic tool',
      rawInput: {},
    });
    await recorder.record({
      type: 'tool.update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'summary' } }],
    });
    await recorder.complete('end_turn');

    expect(recorder.losses).not.toContain('acp_no_step_boundaries');
    expect(JSON.stringify(loopEvents)).not.toContain('ACP');
    expect(JSON.stringify(loopEvents)).toContain('external executor content');
  });

  it('materializes ACP assistant and tool media with exact bytes and stable ids', async () => {
    const loopEvents: unknown[] = [];
    const stored = new Map<string, Uint8Array>();
    const mediaStore = {
      _serviceBrand: undefined,
      pathFor: () => undefined,
      resolveDisplayPath: async () => undefined,
      read: async () => undefined,
      open: async () => undefined,
      materialize: async (input: { fileId: string; stream: () => NodeJS.ReadableStream }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream() as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        stored.set(input.fileId, Buffer.concat(chunks));
        return `media/${input.fileId}`;
      },
    } as unknown as ISessionMediaStore;
    const observed: Event2[] = [];
    const dispatcher = { _serviceBrand: undefined, dispatch: async (event: Event2) => { observed.push(event); } } as unknown as IEventDispatcher;
    const wire = { _serviceBrand: undefined, flush: async () => {} } as unknown as IWireService;
    const contextMemory = {
      _serviceBrand: undefined,
      get: () => [],
      append: () => {},
      appendManaged: () => {},
      appendLoopEvent: (event: unknown) => loopEvents.push(event),
    } as unknown as IAgentContextMemoryService;
    const usage = {
      _serviceBrand: undefined,
      record: () => {},
      status: () => ({}),
      onDidRecord: () => ({ dispose: () => {} }),
    } as IAgentUsageService;
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, dispatcher], [IWireService, wire],
      [IAgentContextMemoryService, contextMemory], [IAgentUsageService, usage],
      [ISessionMediaStore, mediaStore],
    ]);
    const recorder = new ExternalTurnRecorder(
      { id: 'media-agent', accessor: { get: (id) => services.get(id) as never } },
      3,
      'media-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native' },
    );
    await recorder.begin('work', { kind: 'user' });
    await recorder.record({ type: 'message.delta', role: 'assistant', content: {
      type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64'),
    } });
    await recorder.record({ type: 'message.delta', role: 'assistant', content: {
      type: 'audio', mimeType: 'audio/wav', data: Buffer.from([7, 8]).toString('base64'),
    } });
    await recorder.record({ type: 'message.delta', role: 'assistant', content: {
      type: 'resource_link', uri: 'https://example.test/resource', name: 'remote', mimeType: 'text/plain', size: 12,
      title: 'Remote title', description: 'Remote description',
    } });
    const diffOldText = `before-${'o'.repeat(9000)}`;
    const diffNewText = `after-${'n'.repeat(9000)}`;
    const terminalOutput = `terminal-${'t'.repeat(9000)}`;
    const resourceContent = [
      { type: 'content', content: { type: 'resource', resource: {
        uri: 'urn:embedded', blob: Buffer.from([4, 5, 6]).toString('base64'), mimeType: 'application/octet-stream',
      } } },
      { type: 'content', content: { type: 'diff', path: 'src/example.ts', oldText: diffOldText, newText: diffNewText } },
      { type: 'content', content: { type: 'terminal', terminalId: 'terminal-1', output: terminalOutput } },
    ];
    await recorder.record({ type: 'tool.call', toolCallId: 'media-tool', title: 'Media tool', content: resourceContent, rawOutput: 'same update summary' });
    expect(observed.filter((event) => event.type === 'executor.tool.display').at(-1)).toMatchObject({
      output: { text: expect.stringContaining('same update summary'), media: expect.arrayContaining([
        expect.objectContaining({ attachment: expect.any(Object) }),
      ]) },
    });
    await recorder.record({ type: 'tool.update', toolCallId: 'media-tool', status: 'in_progress', rawOutput: 'later summary' });
    await recorder.record({ type: 'tool.update', toolCallId: 'media-tool', rawOutput: 'later summary' });
    await recorder.record({ type: 'tool.update', toolCallId: 'media-tool', rawOutput: '' });
    await recorder.record({ type: 'tool.update', toolCallId: 'media-tool', content: [{ type: 'content', content: { type: 'text', text: 'later text content' } }] });
    await recorder.record({ type: 'tool.update', toolCallId: 'media-tool', status: 'completed' });
    await recorder.complete('end_turn');

    expect([...stored.values()]).toEqual([Buffer.from([1, 2, 3]), Buffer.from([7, 8]), Buffer.from([4, 5, 6])]);
    const contentPart = loopEvents.find((event): event is { type: 'content.part'; part: Record<string, unknown> } =>
      typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'content.part');
    expect(contentPart?.part).toMatchObject({
      type: 'image_url', imageUrl: { id: expect.stringMatching(/^f_acp_/), url: expect.stringContaining('kimi-file://') },
    });
    const resourceLinkPart = loopEvents.find((event): event is { type: 'content.part'; part: Record<string, unknown> } =>
      typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'content.part' &&
      typeof (event as { part?: unknown }).part === 'object' && (event as { part: { resourceLink?: unknown } }).part.resourceLink !== undefined);
    expect(resourceLinkPart?.part).toMatchObject({
      type: 'text', resourceLink: { uri: 'https://example.test/resource', title: 'Remote title', description: 'Remote description' },
    });
    const toolResult = loopEvents.find((event): event is { type: 'tool.result'; result: { output: unknown } } =>
      typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'tool.result')!;
    expect(toolResult.result.output).toEqual([
      expect.objectContaining({ type: 'text', attachment: expect.objectContaining({ mimeType: 'application/octet-stream' }) }),
      expect.objectContaining({ type: 'text', text: expect.stringContaining(diffOldText) }),
      expect.objectContaining({ type: 'text', text: expect.stringContaining(terminalOutput) }),
      { type: 'text', text: 'same update summary' },
      { type: 'text', text: 'later summary' },
      { type: 'text', text: 'later text content' },
    ]);
    expect((toolResult.result.output as readonly { text?: string }[])[1]?.text).toContain(diffNewText);
    expect(JSON.stringify(loopEvents)).not.toContain('AQID');
    expect(JSON.stringify(observed)).not.toContain('BAUG');
    expect(observed.filter((event) => event.type === 'executor.tool.display').at(-1)).toMatchObject({
      output: { media: expect.arrayContaining([expect.objectContaining({ attachment: expect.any(Object) })]) },
    });
    const withoutStorage = new Map(services);
    withoutStorage.delete(ISessionMediaStore);
    const diagnostic = new ExternalTurnRecorder(
      { id: 'diagnostic-agent', accessor: { get: (id) => withoutStorage.get(id) as never } }, 4, 'diagnostic-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native' },
    );
    await diagnostic.begin('work', { kind: 'user' });
    await diagnostic.record({ type: 'message.delta', role: 'assistant', content: { type: 'image', mimeType: 'image/png', data: '!invalid!' } });
    await diagnostic.record({ type: 'message.delta', role: 'assistant', content: { type: 'audio', mimeType: 'audio/wav', data: 'AQI=' } });
    await diagnostic.complete('end_turn');
    expect(JSON.stringify(loopEvents)).toContain('invalid base64');
    expect(JSON.stringify(loopEvents)).toContain('media storage is unavailable');

    const rejectedStorage = new Map(services);
    rejectedStorage.set(ISessionMediaStore, { ...mediaStore, materialize: async () => { throw new Error('storage rejected'); } });
    const failures = [
      { services, reason: 'invalid base64', encoded: '!invalid-tool!', content: { type: 'image', mimeType: 'image/png', data: '!invalid-tool!' } },
      { services: withoutStorage, reason: 'media storage is unavailable', encoded: 'AQI=', content: { type: 'audio', mimeType: 'audio/wav', data: 'AQI=' } },
      { services: rejectedStorage, reason: 'media storage rejected it', encoded: 'AQI=', content: { type: 'resource', resource: { uri: 'urn:failed', blob: 'AQI=', mimeType: 'application/octet-stream' } } },
    ];
    for (const [index, failure] of failures.entries()) {
      const start = loopEvents.length;
      const displayStart = observed.length;
      const tool = new ExternalTurnRecorder(
        { id: 'failed-media-agent', accessor: { get: (id) => failure.services.get(id) as never } }, 5 + index, 'failed-media-session',
        { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native' },
      );
      await tool.begin('work', { kind: 'user' });
      await tool.record({ type: 'tool.update', toolCallId: `failed-media-${index}`, title: 'Failed media tool', status: 'completed',
        content: [{ type: 'content', content: failure.content }], rawOutput: 'safe summary' });
      await tool.complete('end_turn');
      const result = loopEvents.slice(start).find((event): event is { type: 'tool.result'; result: { output: unknown } } =>
        typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'tool.result');
      expect(result?.result.output).toEqual([
        { type: 'text', text: expect.stringContaining(failure.reason) },
        { type: 'text', text: 'safe summary' },
      ]);
      expect(observed.slice(displayStart).filter((event) => event.type === 'executor.tool.display').at(-1)).toMatchObject({
        output: { text: expect.stringContaining(failure.reason), media: result?.result.output },
      });
      expect(JSON.stringify(loopEvents.slice(start))).not.toContain(failure.encoded);
      expect(JSON.stringify(observed.slice(displayStart))).not.toContain(failure.encoded);
      expect(tool.losses).toContain('unknown_update_dropped');
    }
  });

  it('does not duplicate a terminal result when the first update creates the tool', async () => {
    const loopEvents: unknown[] = [];
    const observed: Event2[] = [];
    const dispatcher = {
      _serviceBrand: undefined,
      dispatch: async (event: Event2) => { observed.push(event); },
    } as unknown as IEventDispatcher;
    const contextMemory = {
      _serviceBrand: undefined,
      get: () => [],
      append: () => {},
      appendManaged: () => {},
      appendLoopEvent: (event: unknown) => loopEvents.push(event),
    } as unknown as IAgentContextMemoryService;
    const wire = { _serviceBrand: undefined, flush: async () => {} } as unknown as IWireService;
    const usage = {
      _serviceBrand: undefined,
      record: () => {},
      status: () => ({}),
      onDidRecord: () => ({ dispose: () => {} }),
    } as IAgentUsageService;
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, dispatcher], [IWireService, wire],
      [IAgentContextMemoryService, contextMemory], [IAgentUsageService, usage],
    ]);
    const recorder = new ExternalTurnRecorder(
      { id: 'terminal-agent', accessor: { get: (id) => services.get(id) as never } },
      4,
      'terminal-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native' },
    );
    await recorder.begin('work', { kind: 'user' });
    await recorder.record({
      type: 'tool.update',
      toolCallId: 'first-update-tool',
      title: 'First update tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'terminal output' } }],
    });
    await recorder.complete('end_turn');

    expect(loopEvents.filter((event) => typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'tool.result')).toHaveLength(1);
    expect(observed.filter((event) => event.type === 'tool.result')).toHaveLength(1);
  });

  it('holds a steering boundary until running external tools settle and releases it as unsettled when the turn ends', async () => {
    const dispatcher = { _serviceBrand: undefined, dispatch: async () => {} } as unknown as IEventDispatcher;
    const contextMemory = {
      _serviceBrand: undefined,
      get: () => [],
      append: () => {},
      appendManaged: () => {},
      appendLoopEvent: () => {},
    } as unknown as IAgentContextMemoryService;
    const wire = { _serviceBrand: undefined, flush: async () => {} } as unknown as IWireService;
    const usage = {
      _serviceBrand: undefined,
      record: () => {},
      status: () => ({}),
      onDidRecord: () => ({ dispose: () => {} }),
    } as IAgentUsageService;
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, dispatcher], [IWireService, wire],
      [IAgentContextMemoryService, contextMemory], [IAgentUsageService, usage],
    ]);
    const recorder = new ExternalTurnRecorder(
      { id: 'steer-agent', accessor: { get: (id) => services.get(id) as never } },
      1,
      'steer-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native' },
    );
    await recorder.begin('work', { kind: 'user' });
    const signal = new AbortController().signal;
    await expect(recorder.toolsSettled(signal)).resolves.toBe(true);
    await recorder.record({ type: 'tool.call', toolCallId: 'running-tool', title: 'Running tool', status: 'in_progress' });
    let settled: boolean | undefined;
    const boundary = recorder.toolsSettled(signal).then((value) => { settled = value; return value; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    await recorder.record({
      type: 'tool.update',
      toolCallId: 'running-tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    });
    await expect(boundary).resolves.toBe(true);

    await recorder.record({ type: 'tool.call', toolCallId: 'second-tool', title: 'Second tool', status: 'in_progress' });
    const aborted = new AbortController();
    const abortedBoundary = recorder.toolsSettled(aborted.signal);
    aborted.abort();
    await expect(abortedBoundary).resolves.toBe(false);
    const ended = recorder.toolsSettled(signal);
    await recorder.complete('end_turn');
    await expect(ended).resolves.toBe(false);
    await expect(recorder.toolsSettled(signal)).resolves.toBe(false);
  });

  it('places a pinned argv model before the harness subcommand', async () => {
    const fixture = createTestAgent();
    try {
      await fixture.ready;
      const context = {
        agent: { id: 'main', accessor: { get: <T>(id: Parameters<AgentExecutorContext['agent']['accessor']['get']>[0]) => fixture.get(id) as T } },
        descriptor: {
          id: 'cursor-acp',
          protocol: 'acp-v1' as const,
          command: 'cursor-agent',
          args: ['acp'],
          modelBinding: 'argv' as const,
          modelArgs: ['--model', '{model}'],
          revision: 'r1',
        },
        binding: {
          modelAlias: 'cursor-model',
          thinkingLevel: 'off',
          systemPrompt: 'prompt',
        },
      } satisfies AgentExecutorContext;

      expect(resolveAcpProcessArgs(context)).toEqual([
        '--model',
        'cursor-model',
        'acp',
      ]);
      expect(resolveAcpProcessArgs({
        ...context,
        binding: { ...context.binding, modelAlias: undefined },
      })).toEqual(['acp']);
    } finally {
      await fixture.dispose();
    }
  });

  it('suppresses an exact outbound prompt echo from external user frames', async () => {
    const harness = createHarness({
      mode: 'live',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
      events: [{
        type: 'message.delta',
        role: 'user',
        messageId: 'prompt-echo',
        content: { type: 'text', text: 'work' },
      }],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.appendedMessages).toEqual([]);
  });

  it('delivers pending Todo, goal and notification context before an external turn', async () => {
    const harness = createExecutionHarness({ history: [
      { id: 'todo-1', role: 'user', content: [{ type: 'text', text: 'Todo: finish tests' }],
        toolCalls: [], origin: { kind: 'injection', variant: 'todo_list_reminder' } },
      { id: 'goal-1', role: 'user', content: [{ type: 'text', text: 'Goal: land backend' }],
        toolCalls: [], origin: { kind: 'injection', variant: 'goal_state' } },
      { id: 'notify-1', role: 'user', content: [{ type: 'text', text: 'Child completed' }],
        toolCalls: [], origin: { kind: 'task', taskId: 'child', status: 'completed', notificationId: 'done' } },
      { id: 'notify-2', role: 'user', content: [{ type: 'text', text: 'AgentNotify: sibling ready' }],
        toolCalls: [], origin: { kind: 'agent_message', messageId: 'notify-2', senderAgentId: 'sibling', senderTaskName: 'sibling' } },
    ] });
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'Continue' },
        { signal: new AbortController().signal });
      expect(harness.starts[0]?.prompt).toContain('Todo: finish tests');
      expect(harness.starts[0]?.prompt).toContain('Goal: land backend');
      expect(harness.starts[0]?.prompt).toContain('Child completed');
      expect(harness.starts[0]?.prompt).toContain('AgentNotify: sibling ready');
      expect(harness.starts[0]?.prompt).toContain('Continue');
      run.turn.cancel();
      await harness.turnCancel();
      await run.completion.catch(() => undefined);
    } finally {
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it.each(['external-agent', 'main'] as const)('sends only the %s agent\'s live Todo and goal state', async (agentId) => {
    const harness = createExecutionHarness({
      agentId,
      todos: [{ title: 'Finish integration', status: 'in_progress' }],
      notes: { next: 'Run the server test' },
      goal: {
        goalId: 'goal-1', objective: 'Land the external harness', status: 'active',
        completionCriterion: 'All tests green', turnsUsed: 0, tokensUsed: 0, wallClockMs: 0,
        budget: {
          tokenBudget: null, turnBudget: null, wallClockBudgetMs: null,
          remainingTokens: null, remainingTurns: null, remainingWallClockMs: null,
          tokenBudgetReached: false, turnBudgetReached: false, wallClockBudgetReached: false,
          overBudget: false,
        },
      },
    });
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'Continue' },
        { signal: new AbortController().signal });
      if (agentId === 'main') {
        expect(harness.starts[0]?.prompt).toContain('Goal (active): Land the external harness');
        expect(harness.starts[0]?.prompt).toContain('Completion criterion: All tests green');
      } else {
        expect(harness.starts[0]?.prompt).not.toContain('[Kiki goal_state]');
      }
      expect(harness.starts[0]?.prompt).toContain('[in_progress] Finish integration');
      expect(harness.starts[0]?.prompt).toContain('next: Run the server test');
      expect(harness.events.filter((event) => event instanceof ExecutorHintDelivery)).toMatchObject([
        ...agentId === 'main' ? [{ origin: 'goal_state', method: 'next_turn_preamble', status: 'delivered' }] : [],
        { origin: 'todo_state', method: 'next_turn_preamble', status: 'delivered' },
      ]);
      await harness.turnCancel();
      await run.completion.catch(() => undefined);
    } finally {
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('leaves an external prompt unchanged when no hints or state exist', async () => {
    const harness = createExecutionHarness();
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'Continue' },
        { signal: new AbortController().signal });
      expect(harness.starts[0]?.prompt).toMatch(/--- END KIKI FROZEN PROFILE INSTRUCTIONS ---\n\nContinue$/);
      expect(harness.starts[0]?.prompt).not.toContain('[Kiki todo_state]');
      expect(harness.starts[0]?.prompt).not.toContain('[Kiki goal_state]');
      expect(harness.events.some((event) => event instanceof ExecutorHintDelivery)).toBe(false);
      await harness.turnCancel();
      await run.completion.catch(() => undefined);
    } finally {
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('marks an oversized context hint undelivered and forwards the following notification', async () => {
    const harness = createExecutionHarness({ history: [
      { id: 'large', role: 'user', content: [{ type: 'text', text: 'x'.repeat(9 * 1024) }],
        toolCalls: [], origin: { kind: 'injection', variant: 'large' } },
      { id: 'notify', role: 'user', content: [{ type: 'text', text: 'Child completed' }],
        toolCalls: [], origin: { kind: 'task', taskId: 'child', status: 'completed', notificationId: 'done' } },
    ] });
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'Continue' },
        { signal: new AbortController().signal });
      expect(harness.starts[0]?.prompt).toContain('Child completed');
      expect(harness.starts[0]?.prompt).not.toContain('x'.repeat(9 * 1024));
      expect(harness.events.filter((event) => event instanceof ExecutorHintDelivery)).toMatchObject([
        { origin: 'injection:large', method: 'undelivered', status: 'undelivered' },
        { origin: 'task', method: 'next_turn_preamble', status: 'delivered' },
      ]);
      await harness.turnCancel();
      await run.completion.catch(() => undefined);
    } finally {
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('forwards queued collaboration mail through the next ordinary ACP resume before acknowledging it', async () => {
    const harness = createExecutionHarness();
    const mailbox = attachExternalMailboxHarness(harness.ix, 'external-agent');
    try {
      await expect(mailbox.messaging.send({
        sourceAgentId: 'main',
        sourceTaskName: 'root',
        targetAgentId: 'external-agent',
        targetTaskName: 'external-agent',
        content: 'queued ACP mail',
        idempotencyKey: 'queued-acp-mail',
        waitForRunningDelivery: true,
      })).resolves.toMatchObject({ delivery: 'queued' });

      await harness.execution.run(
        { kind: 'prompt', prompt: 'ordinary ACP resume' },
        { signal: new AbortController().signal },
      );

      expect(harness.starts[0]?.prompt).toContain(
        'Message from agent "root" (main):\n\nqueued ACP mail',
      );
      expect(harness.starts[0]?.prompt).toContain('ordinary ACP resume');
      expect(mailbox.delivered()).toBe(true);
    } finally {
      await mailbox.dispose();
      await harness.execution.shutdown();
      await harness.ix.dispose();
    }
  });

  it('runs an idle external executor from a mailbox message with its collaboration origin', async () => {
    const harness = createHarness({ mode: 'live' });
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

    const run = await harness.session.run(
      { kind: 'mailbox', prompt, message },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.starts[0]?.prompt).toContain('Message from agent "root" (main)');
    expect(harness.events.find((event) => event instanceof TurnPrompt)).toMatchObject({
      origin: message.origin,
    });
  });

  it('persists non-echo external user frames as canonical external-origin messages', async () => {
    const harness = createHarness({
      mode: 'live',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
      events: [{
        type: 'message.delta',
        role: 'user',
        messageId: 'external-user-1',
        content: { type: 'text', text: 'remote follow-up' },
      }],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.appendedMessages).toEqual([expect.objectContaining({
      role: 'user',
      id: 'external-user-1',
      content: [{ type: 'text', text: 'remote follow-up' }],
      origin: { kind: 'unknown' },
    })]);
    expect(JSON.stringify(harness.appendedMessages)).not.toContain('external-executor:');
  });

  it('delivers external preamble at observation and keeps a late recognized echo on the safety boundary', async () => {
    const timeline: string[] = [];
    const managed: { message: ContextMessage; delivery: { origin?: string; placement?: string; turnId?: number; stepId?: string; step?: number } }[] = [];
    const dispatcher = { dispatch: async () => {}, flush: async () => {} };
    const wire = { _serviceBrand: undefined, flush: async () => {} };
    const contextMemory = {
      _serviceBrand: undefined,
      appendManaged: (message: ContextMessage, delivery: { origin?: string; placement?: string; turnId?: number; stepId?: string; step?: number }) => {
        timeline.push(`user:${message.id}`);
        managed.push({ message, delivery });
      },
      appendLoopEvent: (event: { type?: string }) => timeline.push(event.type ?? 'loop'),
    };
    const usage = { _serviceBrand: undefined, record: () => {}, status: () => ({}), onDidRecord: () => ({ dispose: () => {} }) };
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, dispatcher], [IWireService, wire],
      [IAgentContextMemoryService, contextMemory], [IAgentUsageService, usage],
    ]);
    const outbound = '[Kiki memory]\nremember this\n\n[Kiki goal_state]\nGoal (active): land\n\nwork';
    const recorder = new ExternalTurnRecorder(
      { id: 'boundary-agent', accessor: { get: (id: unknown) => services.get(id) as never } },
      7,
      'boundary-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native', outboundPrompt: outbound },
    );
    await recorder.begin('work', { kind: 'user' }, [], 'prompt-1');
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'preamble', content: { type: 'text', text: '[Kiki memory]\nremember this' } });
    await recorder.record({ type: 'message.delta', role: 'assistant', messageId: 'assistant-1', content: { type: 'text', text: 'doing it' } });
    await recorder.record({ type: 'tool.call', toolCallId: 'read-1', title: 'Read', status: 'pending' });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'echo', content: { type: 'text', text: outbound } });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'prompt-echo', content: { type: 'text', text: 'work' } });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'follow-up', content: { type: 'text', text: 'remote follow-up' } });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'late', content: { type: 'text', text: '[Kiki goal_state]\nGoal (active): land' } });
    await recorder.complete('end_turn');

    expect(timeline).toEqual([
      'step.begin', 'user:preamble', 'content.part', 'tool.call', 'user:follow-up', 'user:late', 'tool.result', 'step.end',
    ]);
    expect(timeline.indexOf('user:preamble')).toBeLessThan(timeline.indexOf('content.part'));
    expect(timeline.indexOf('user:late')).toBeLessThan(timeline.indexOf('step.end'));
    expect(managed.map((entry) => entry.message.origin)).toEqual([
      { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' },
      { kind: 'unknown' },
      { kind: 'injection', variant: 'goal_state', ownerPromptId: 'prompt-1' },
    ]);
    expect(managed.map((entry) => entry.delivery)).toEqual([
      expect.objectContaining({ origin: 'injection', placement: 'safety_boundary', turnId: 7, step: 1 }),
      expect.objectContaining({ origin: 'queue', turnId: 7, step: 1 }),
      expect.objectContaining({ origin: 'injection', placement: 'safety_boundary', turnId: 7, step: 1 }),
    ]);
    expect(managed[1]?.delivery.placement).toBeUndefined();
    expect(managed.every((entry) => entry.delivery.stepId === recorder.stepId)).toBe(true);
    expect(JSON.stringify(managed)).not.toContain('external-executor:');
    expect(JSON.stringify(managed)).not.toContain('system_trigger');
  });

  it('keeps the remainder of one user message when a thought arrives between its deltas', async () => {
    const managed: { message: ContextMessage; delivery: { placement?: string } }[] = [];
    const timeline: string[] = [];
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, { dispatch: async () => {}, flush: async () => {} }],
      [IWireService, { _serviceBrand: undefined, flush: async () => {} }],
      [IAgentContextMemoryService, {
        _serviceBrand: undefined,
        appendManaged: (message: ContextMessage, delivery: { placement?: string }) => {
          timeline.push(`user:${message.id}:${message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')}`);
          managed.push({ message, delivery });
        },
        appendLoopEvent: (event: { type?: string }) => timeline.push(event.type ?? 'loop'),
      }],
      [IAgentUsageService, { _serviceBrand: undefined, record: () => {}, status: () => ({}), onDidRecord: () => ({ dispose: () => {} }) }],
    ]);
    const recorder = new ExternalTurnRecorder(
      { id: 'continue-agent', accessor: { get: (id: unknown) => services.get(id) as never } },
      8,
      'continue-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native', outboundPrompt: 'work' },
    );
    await recorder.begin('work', { kind: 'user' }, [], 'prompt-1');
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'same-user', content: { type: 'text', text: 'hello ' } });
    await recorder.record({ type: 'thought.delta', messageId: 'think-1', content: { type: 'text', text: 'planning' } });
    await recorder.record({ type: 'tool.call', toolCallId: 'read-1', title: 'Read', status: 'pending' });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'same-user', content: { type: 'text', text: 'world' } });
    await recorder.complete('end_turn');

    const same = managed.filter((entry) => entry.message.id === 'same-user');
    expect(same.map((entry) => entry.message.content)).toEqual([
      [{ type: 'text', text: 'hello ' }],
      [{ type: 'text', text: 'hello world' }],
    ]);
    expect(new Set(same.map((entry) => entry.message.id)).size).toBe(1);
    expect(same.every((entry) => entry.message.origin?.kind === 'unknown' && entry.delivery.placement === undefined)).toBe(true);
    expect(timeline).toEqual([
      'step.begin', 'user:same-user:hello ', 'content.part', 'tool.call', 'user:same-user:hello world', 'tool.result', 'step.end',
    ]);
  });

  it('reclassifies a split known preamble without placing the continuation or promoting a later unknown user', async () => {
    const managed: { message: ContextMessage; delivery: { placement?: string } }[] = [];
    const services = new Map<unknown, unknown>([
      [IEventDispatcher, { dispatch: async () => {}, flush: async () => {} }],
      [IWireService, { _serviceBrand: undefined, flush: async () => {} }],
      [IAgentContextMemoryService, {
        _serviceBrand: undefined,
        appendManaged: (message: ContextMessage, delivery: { placement?: string }) => {
          managed.push({ message, delivery });
        },
        appendLoopEvent: () => {},
      }],
      [IAgentUsageService, { _serviceBrand: undefined, record: () => {}, status: () => ({}), onDidRecord: () => ({ dispose: () => {} }) }],
    ]);
    const outbound = '[Kiki memory]\nremember this\n\nwork';
    const recorder = new ExternalTurnRecorder(
      { id: 'split-agent', accessor: { get: (id: unknown) => services.get(id) as never } },
      4,
      'split-session',
      { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native', outboundPrompt: outbound },
    );
    await recorder.begin('work', { kind: 'user' }, [], 'prompt-1');
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'preamble', content: { type: 'text', text: '[Kiki mem' } });
    await recorder.record({ type: 'thought.delta', messageId: 'think-1', content: { type: 'text', text: 'planning' } });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'preamble', content: { type: 'text', text: 'ory]\nremember this' } });
    await recorder.record({ type: 'tool.call', toolCallId: 'read-1', title: 'Read', status: 'pending' });
    await recorder.record({ type: 'message.delta', role: 'user', messageId: 'after', content: { type: 'text', text: 'brand new after tool' } });
    await recorder.complete('end_turn');

    const preamble = managed.filter((entry) => entry.message.id === 'preamble');
    const after = managed.filter((entry) => entry.message.id === 'after');
    expect(preamble.map((entry) => entry.message.origin)).toEqual([
      { kind: 'unknown' },
      { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' },
    ]);
    expect(preamble.map((entry) => entry.message.content)).toEqual([
      [{ type: 'text', text: '[Kiki mem' }],
      [{ type: 'text', text: '[Kiki memory]\nremember this' }],
    ]);
    expect(preamble.every((entry) => entry.delivery.placement === undefined)).toBe(true);
    expect(after.map((entry) => [entry.message.origin, entry.delivery.placement])).toEqual([
      [{ kind: 'unknown' }, undefined],
    ]);
  });

  it('preserves unkeyed external user frames with an attribution loss', async () => {
    const harness = createHarness({
      mode: 'live',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
      events: [{
        type: 'message.delta',
        role: 'user',
        content: { type: 'text', text: 'unkeyed remote follow-up' },
      }],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );

    expect(harness.appendedMessages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'unkeyed remote follow-up' }],
    });
    expect(metadata?.losses).toEqual(expect.arrayContaining([
      'message_id_missing',
      'user_message_attribution_missing',
    ]));
  });

  it.each([undefined, 'owned-prompt'])('attributes external turns to the owning prompt without inventing ids: %s', async (promptId) => {
    const harness = createHarness();
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work', promptId }, { signal: new AbortController().signal });
    await run.completion;
    expect(harness.events.find((event) => event.type === 'turn.prompt')).toMatchObject({ promptId });
    expect(harness.events.find((event) => event.type === 'turn.started')).toMatchObject({ promptId });
  });

  it('uses segment ids shared by live and durable frames and flushes text before tool boundaries', async () => {
    const harness = createHarness({ events: [
      { type: 'thought.delta', messageId: 'shared-message', content: { type: 'text', text: 'think' } },
      { type: 'message.delta', role: 'assistant', messageId: 'shared-message', content: { type: 'text', text: 'before ' } },
      { type: 'message.delta', role: 'assistant', messageId: 'shared-message', content: { type: 'text', text: 'tool' } },
      { type: 'tool.call', toolCallId: 'tool-1', title: 'Read', status: 'pending' },
      { type: 'tool.update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'done' },
      { type: 'message.delta', role: 'assistant', messageId: 'shared-message', content: { type: 'text', text: 'after' } },
    ] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    const records = harness.loopEvents as { type: string; uuid?: string; part?: { type: string; text?: string; think?: string } }[];
    const timeline = records.filter((event) => ['content.part', 'tool.call', 'tool.result'].includes(event.type));
    expect(timeline.map((event) => event.type)).toEqual(['content.part', 'content.part', 'tool.call', 'tool.result', 'content.part']);
    const parts = records.filter((event) => event.type === 'content.part');
    expect(parts.map((event) => event.part)).toEqual([{ type: 'think', think: 'think' }, { type: 'text', text: 'before tool' }, { type: 'text', text: 'after' }]);
    const deltas = harness.events.filter((event): event is AssistantDelta | ThinkingDelta => event instanceof AssistantDelta || event instanceof ThinkingDelta);
    expect(deltas.map((event) => event.partId)).toEqual([parts[0]!.uuid, parts[1]!.uuid, parts[1]!.uuid, parts[2]!.uuid]);
    expect(new Set(parts.map((event) => event.uuid)).size).toBe(3);
    expect(parts.some((event) => event.uuid === 'shared-message')).toBe(false);
  });

  it.each([true, false])('records one tool boundary and result for repeated terminal updates: startsWithCall=%s', async (startsWithCall) => {
    const harness = createHarness({ events: [
      ...(startsWithCall ? [
        { type: 'tool.call' as const, toolCallId: 'repeated', title: 'Read', status: 'pending' },
        { type: 'tool.call' as const, toolCallId: 'repeated', title: 'Read', status: 'in_progress' },
      ] : []),
      { type: 'tool.update', toolCallId: 'repeated', status: 'completed', rawOutput: 'done' },
      { type: 'tool.update', toolCallId: 'repeated', status: 'completed', rawOutput: 'done' },
    ] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    const records = harness.loopEvents as { type: string }[];
    expect(records.filter((event) => event.type === 'tool.call')).toHaveLength(1);
    expect(records.filter((event) => event.type === 'tool.result')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'tool.call.started')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'tool.result')).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'])('keeps partial ACP output and refreshed display for %s', async (status) => {
    const content = [{ type: 'content', content: { type: 'text', text: 'partial output' } }];
    const harness = createHarness({ events: [
      { type: 'tool.update', toolCallId: 'stream', kind: 'execute', status: 'in_progress', rawInput: { command: 'first' }, content },
      { type: 'tool.call', toolCallId: 'stream', title: 'Bash', kind: 'execute', rawInput: { command: 'second', cwd: '/work' } },
      { type: 'tool.update', toolCallId: 'stream', status, content: [], rawOutput: '' },
      { type: 'tool.update', toolCallId: 'stream', rawInput: { command: 'third' } },
    ] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    const snapshots = harness.events.filter((event): event is ExecutorToolDisplay => event instanceof ExecutorToolDisplay);
    expect(harness.events.filter((event) => event.type === 'tool.call.started')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'tool.result')).toHaveLength(1);
    expect(new Set(snapshots.map((event) => event.toolCallId)).size).toBe(1);
    expect(snapshots.at(-1)).toMatchObject({ name: 'Bash', state: status === 'failed' ? 'error' : 'interrupted',
      display: { kind: 'command', command: 'third' },
      output: { text: 'partial output', content, remoteToolCallId: 'stream', remoteSessionId: 'remote-2:e1', status },
    });
    await harness.session.shutdown();
  });

  it('interrupts unreported ACP calls without inventing a tool failure at a successful turn end', async () => {
    const harness = createHarness({ events: [{ type: 'tool.call', toolCallId: 'unfinished', title: 'Read', kind: 'read', rawInput: { path: 'a.ts' }, status: 'pending' }] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    expect(harness.events.filter((event) => event instanceof ExecutorToolDisplay).at(-1)).toMatchObject({ state: 'interrupted', output: { status: 'pending', synthetic: false, text: '' } });
    expect(JSON.stringify(harness.loopEvents)).not.toContain('External tool did not report a terminal result');
    await harness.session.shutdown();
  });

  it('replays observed Grok extension shapes into tool input and interaction facts, not assistant prose', async () => {
    const extension = (update: unknown) => mapAcpSessionNotification({ sessionId: 'session-1', update }, '_x.ai/session_notification').event;
    const harness = createHarness({ events: [
      extension({ sessionUpdate: 'session_summary_generated', session_summary: 'Inspect project' }),
      extension({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 0, tool_call_id: 'call-1', name: 'Shell' }),
      extension({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 0, arguments_delta: '{"command":"echo ' }),
      extension({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 0, arguments_delta: 'ok"}' }),
      extension({ sessionUpdate: 'response_completed', stop_reason: 'tool_use', usage: { output_tokens: 7 } }),
      { type: 'tool.call', toolCallId: 'call-1', title: 'Shell', kind: 'execute', rawInput: { command: 'echo ok' } },
      extension({ sessionUpdate: 'pending_interaction', tool_call_id: 'call-1', kind: 'permission' }),
      extension({ sessionUpdate: 'interaction_resolved', tool_call_id: 'call-1' }),
      { type: 'tool.update', toolCallId: 'call-1', status: 'completed', rawOutput: 'ok' },
      extension({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 0, tool_call_id: 'call-2', name: 'Read', arguments_delta: '{"path":"example.ts"}' }),
      { type: 'tool.call', toolCallId: 'call-2', title: 'Read', rawInput: { path: 'example.ts' } },
      { type: 'tool.update', toolCallId: 'call-2', status: 'completed', rawOutput: 'contents' },
      extension({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn', usage: { inputTokens: 12 }, elapsed_ms: 100 }),
      { type: 'message.delta', role: 'assistant', messageId: 'message-1', content: { type: 'text', text: 'Actual answer' } },
    ] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    const runtime = harness.events.filter((event): event is ExecutorRuntimeUpdate => event instanceof ExecutorRuntimeUpdate);
    expect(runtime.filter((event) => event.kind === 'unknown')).toEqual([]);
    expect(runtime.filter((event) => event.kind === 'tool_input').map((event) => event.value)).toMatchObject([
      { name: 'Shell', inputText: '' }, { inputText: '{"command":"echo ' },
      { inputText: '{"command":"echo ok"}' }, { name: 'Read', inputText: '{"path":"example.ts"}' },
    ]);
    expect(harness.events.filter((event) => event.type === 'tool.result')).toHaveLength(2);
    expect(runtime.filter((event) => event.kind === 'tool_progress').map((event) => event.value)).toMatchObject([
      { update: { text: 'Waiting for permission', customData: { interaction: 'pending' } } },
      { update: { text: 'Interaction resolved', customData: { interaction: 'resolved' } } },
    ]);
    expect(harness.events.filter((event) => event instanceof AssistantDelta).map((event) => event.delta)).toEqual(['Actual answer']);
    expect(runtime).toContainEqual(expect.objectContaining({ kind: 'session', value: expect.objectContaining({ meta: expect.objectContaining({ completion: expect.objectContaining({ stopReason: 'end_turn' }) }) }) }));
  });

  it('keeps bounded secret-redacted unknown payloads and does not reuse an index after a response boundary', async () => {
    const harness = createHarness({ events: [
      { type: 'tool.input.delta', toolIndex: 0, toolCallId: 'old-call', name: 'Read', delta: '{}' },
      { type: 'response.completed', meta: { stopReason: 'tool_use' } },
      { type: 'tool.input.delta', toolIndex: 0, delta: 'unattributed' },
      { type: 'unknown', updateType: 'future_update', method: '_x.ai/session_notification', payload: {
        api_key: 'YOUR_API_KEY', nested: { password: 'secret-value', text: 'Bearer abcdefghijklmnopqrstuvwxyz' }, facts: '界'.repeat(10000),
      } },
    ] });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    const runtime = harness.events.filter((event): event is ExecutorRuntimeUpdate => event instanceof ExecutorRuntimeUpdate);
    expect(runtime.filter((event) => event.kind === 'tool_input')).toHaveLength(1);
    const diagnostic = runtime.find((event) => event.kind === 'unknown' && (event.value as { updateType: string }).updateType === 'future_update')!;
    const json = JSON.stringify(diagnostic.value);
    expect(json).not.toContain('YOUR_API_KEY');
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(json).not.toContain('�');
    expect(Buffer.byteLength(json)).toBeLessThan(9000);
    expect(diagnostic.value).toMatchObject({ method: '_x.ai/session_notification', payload: { truncated: true } });
  });

  it('maps normalized events to live and canonical durable records with stable losses', async () => {
    const harness = createHarness({
      permissionMode: 'manual',
      events: mappingEvents,
      approval: async () => ({ decision: 'approved', selectedOptionId: 'allow-once' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({ summary: 'answer', usage: undefined });
    await expect(run.turn.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });

    expect(harness.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'turn.prompt',
      'turn.started',
      'turn.step.started',
      'assistant.delta',
      'thinking.delta',
      'tool.call.started',
      'tool.result',
      'executor.plan.update',
      'executor.runtime.update',
      'executor.turn.metadata',
      'turn.step.completed',
      'turn.ended',
    ]));
    const toolCall = harness.loopEvents.find(
      (event) => (event as { type?: string }).type === 'tool.call',
    ) as { toolCallId: string };
    expect(toolCall.toolCallId).toBe('external:remote-2%3Ae1:tool-1');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.losses).toEqual(expect.arrayContaining([
      'acp_no_step_boundaries',
      'profile_as_user_preamble',
      'message_id_missing',
      'tool_input_partial',
      'usage_context_only',
      'unknown_update_dropped',
      'unstable_acp_plan',
    ]));
    expect(metadata?.losses).not.toContain('tool_output_summary_only');
    expect(harness.events.filter((event) => event instanceof ExecutorToolDisplay).at(-1)).toMatchObject({
      output: { text: 'summary', content: mappingEvents[3]?.type === 'tool.update' ? mappingEvents[3].content : undefined },
    });
    expect(harness.events.some((event) => event instanceof ExecutorPlanUpdate)).toBe(true);
    expect(harness.events.some((event) => event instanceof ExecutorRuntimeUpdate)).toBe(true);
    expect(harness.wire.flush).toHaveBeenCalled();
    expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'allow-once' }]);
    expect(harness.selections).toEqual([
      { configId: 'model-id', value: 'model-a' },
      { configId: 'thought-id', value: 'high' },
      { configId: 'auto_approve', value: false },
    ]);
  });

  it('rejects an unadvertised AGY effort and selects the effort the session menu embeds', async () => {
    const effortMenu = (values: readonly string[]): AcpSessionConfigOption => ({
      id: 'effort', name: 'AGY effort', category: 'thought_level', type: 'select', currentValue: 'engine-default',
      options: values.map((value) => ({ value, name: value })),
    });
    const bare = createHarness({
      modelBinding: 'argv', modelArgs: ['--model', '{model}'], modelAlias: 'anthropic/claude-opus-5-5',
      thinkingEffort: 'high', thoughtConfigId: 'effort', permissionMapping: null,
      sessionConfigOptions: [effortMenu(['engine-default'])],
    });
    await expect(bare.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'model.not_found',
      details: {
        reason_code: 'executor_thought_level_unavailable', config_id: 'effort', requested_value: 'high',
        available_values: ['engine-default'],
      },
    });
    expect(bare.starts).toHaveLength(0);
    expect(bare.selections).toEqual([]);

    const embedded = createHarness({
      modelBinding: 'argv', modelArgs: ['--model', '{model}'], modelAlias: 'claude-opus-5-5-high',
      thinkingEffort: 'high', thoughtConfigId: 'effort', permissionMapping: null,
      sessionConfigOptions: [effortMenu(['engine-default', 'high'])],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const run = await embedded.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    expect(embedded.selections).toEqual([{ configId: 'effort', value: 'high' }]);

    const off = createHarness({
      modelBinding: 'argv', modelArgs: ['--model', '{model}'], modelAlias: 'claude-opus-5-5-high',
      thinkingEffort: 'off', thoughtConfigId: 'effort', permissionMapping: null,
      sessionConfigOptions: [effortMenu(['engine-default', 'high'])],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const skipped = await off.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await skipped.completion;
    expect(off.selections).toEqual([]);
  });

  it('keeps unpinned external models ambient and diagnoses explicit unadvertised aliases', async () => {
    const ambient = createHarness({ unpinModel: true, thinkingEffort: 'off' });
    const run = await ambient.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    expect(ambient.selections.some((selection) => selection.configId === 'model-id')).toBe(false);
    const invalid = createHarness({ modelAlias: 'provider/native-model' });
    await expect(invalid.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'model.not_found', details: { reason_code: 'executor_model_unavailable',
        requested_value: 'provider/native-model', available_values: ['model-a', 'ambient-model'],
        hint: expect.stringContaining('leave it unpinned') },
    });
    expect(invalid.starts).toHaveLength(0);
  });

  it('passes the original Grok alias and xhigh through session config', async () => {
    const sessionConfigOptions = configOptions().map((option) => {
      if (option.id === 'model-id' && option.type === 'select') {
        return {
          ...option,
          options: [...option.options, { value: 'grok-4.6', name: 'Grok 4.6' }],
        };
      }
      if (option.id === 'thought-id' && option.type === 'select') {
        return {
          ...option,
          options: [...option.options, { value: 'xhigh', name: 'Extra high' }],
        };
      }
      return option;
    }) as AcpSessionConfigOption[];
    const harness = createHarness({
      executorId: 'grok-acp',
      profileDelivery: BUILTIN_AGENT_EXECUTORS['grok-acp']?.profileDelivery,
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.selections).toContainEqual({ configId: 'model-id', value: 'grok-4.6' });
    expect(harness.selections).toContainEqual({ configId: 'thought-id', value: 'xhigh' });
  });

  it('delivers an opted-in ACP profile in session/new instead of the user prompt', async () => {
    const harness = createHarness({ profileDelivery: 'system_prompt_override' });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.systemPromptOverride).toBe('Frozen profile');
    expect(harness.starts[0]?.prompt).toBe('work');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.profileDelivery).toBe('system_prompt_override');
    expect(metadata?.losses).not.toContain('profile_as_user_preamble');
    expect((harness.state.get(externalExecutorKey)).profileDelivery).toBe('system_prompt_override');
  });

  it('keeps the user-prompt preamble for harnesses without the override capability', async () => {
    const harness = createHarness();
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.systemPromptOverride).toBeUndefined();
    expect(harness.starts[0]?.prompt).toContain('BEGIN KIKI FROZEN PROFILE INSTRUCTIONS');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.profileDelivery).toBe('first_prompt_preamble');
    expect(metadata?.losses).toContain('profile_as_user_preamble');
  });

  it('reuses an existing override-backed session across process instances without repeating the profile', async () => {
    const harness = createHarness({
      mode: 'resume',
      profileDelivery: 'system_prompt_override',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
        profileDelivery: 'system_prompt_override',
      },
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.sessionRef?.ref['sessionId']).toBe('remote-2');
    expect(harness.starts[0]?.prompt).toBe('continue');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata).toMatchObject({ resumeMode: 'resume', profileDelivery: 'system_prompt_override' });
    expect(metadata?.losses).not.toContain('profile_as_user_preamble');
  });

  it('keeps a legacy preamble session on resume when the descriptor enables overrides later', async () => {
    const harness = createHarness({
      mode: 'load',
      profileDelivery: 'system_prompt_override',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.starts[0]?.prompt).toBe('continue');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.profileDelivery).toBe('first_prompt_preamble');
    expect(metadata?.losses).not.toContain('profile_as_user_preamble');
  });

  it('creates a new override-backed session when the frozen profile changes', async () => {
    const harness = createHarness({
      profileDelivery: 'system_prompt_override',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-1' } },
        profileDeliveredSessionId: 'remote-1',
        profileDelivery: 'system_prompt_override',
      },
    });
    const session = harness.createSession({
      ...harness.executorContext,
      binding: { ...harness.executorContext.binding, systemPrompt: 'Changed profile' },
    });
    const run = await session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.sessionRef).toBeUndefined();
    expect(harness.opens[0]?.systemPromptOverride).toBe('Changed profile');
    expect(harness.starts[0]?.prompt).toContain('work');
    expect(harness.starts[0]?.prompt).not.toContain('BEGIN KIKI FROZEN PROFILE INSTRUCTIONS');
  });

  it('releases an ACP wrapper that failed before any original session or prompt existed', async () => {
    const harness = createExecutionHarness();
    vi.spyOn(harness.client, 'openSession').mockRejectedValueOnce(new AcpClientError('executor.spawn_failed', 'temporary spawn failure'));
    try {
      await expect(harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toThrow('temporary spawn failure');
      expect(harness.execution.status()).toEqual({ state: 'broken' });
      expect(harness.execution.canResumeBrokenOriginal()).toBe(false);
      expect(harness.execution.canRetryBrokenExecution()).toBe(true);
      expect(harness.client.shutdown).toHaveBeenCalledOnce();
      expect(harness.starts).toHaveLength(0);
      const handle = await harness.execution.run({ kind: 'prompt', prompt: 'retry construction' }, { signal: new AbortController().signal });
      expect(harness.starts).toHaveLength(1);
      harness.execution.cancel();
      await expect(handle.completion).rejects.toThrow('External ACP turn cancelled');
      await harness.execution.settled();
      expect(harness.execution.status()).toEqual({ state: 'idle' });
    } finally { await harness.execution.dispose(); await harness.ix.dispose(); }
  });

  it('saves a new ACP session before prompt delivery and retains it after an unknown start outcome', async () => {
    const harness = createHarness();
    vi.spyOn(harness.client, 'startTurn').mockImplementationOnce(async () => {
      expect(harness.state.get(externalExecutorKey)).toMatchObject({ sessionRef: { ref: { sessionId: 'remote-2' } }, sessionEpoch: 1 });
      expect(harness.wire.flush).toHaveBeenCalled();
      throw new AcpClientError('executor.disconnected', 'unknown prompt outcome');
    });
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toThrow('unknown prompt outcome');
      expect(harness.session.canRetryBrokenConstruction()).toBe(false);
      expect(harness.state.get(externalExecutorKey).sessionRef?.ref['sessionId']).toBe('remote-2');
      expect(harness.client.startTurn).toHaveBeenCalledOnce();
    } finally { await harness.session.shutdown(); }
  });

  it('resumes a broken ACP child only on the original binding and remote session', async () => {
    const prior = {
      executorId: 'example-acp',
      descriptorRevision: 'r1',
      sessionEpoch: 1,
      sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
    };
    const permission = {
      via: 'argv' as const,
      flag: '--permission-mode',
      manual: 'default',
      auto: 'acceptEdits',
      yolo: 'bypassPermissions',
    };
    const recoverable = createHarness({ clientState: 'broken', permission, prior, mode: 'resume' });
    const drifted = createHarness({
      clientState: 'broken', permission, prior, mode: 'resume', priorBindingFingerprint: '0'.repeat(64),
    });
    const noArgv = createHarness({ clientState: 'broken', prior, mode: 'resume' });
    const refused = createHarness({ clientState: 'broken', permission, prior, mode: 'resume' });
    refused.executorContext.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(
      'example-acp', undefined, { resume: false, load: false },
    );
    const busy = createHarness({
      clientState: 'broken', permission, prior, mode: 'resume', deferTurnCompletion: true,
    });
    try {
      expect(recoverable.session.status()).toEqual({ state: 'broken' });
      expect(recoverable.session.canResumeBrokenOriginal?.()).toBe(true);
      expect(drifted.session.canResumeBrokenOriginal?.()).toBe(false);
      expect(noArgv.session.canResumeBrokenOriginal?.()).toBe(true);
      await (await noArgv.session.run({ kind: 'prompt', prompt: 'same session' }, { signal: new AbortController().signal })).completion;
      expect(noArgv.opens[0]).toMatchObject({ requireResume: true, sessionRef: { ref: { sessionId: 'remote-2' } } });
      expect(refused.session.canResumeBrokenOriginal?.()).toBe(false);
      const run = await busy.session.run({ kind: 'prompt', prompt: 'busy' }, { signal: new AbortController().signal });
      expect(busy.opens[0]).toMatchObject({
        requireResume: true,
        sessionRef: { ref: { sessionId: 'remote-2' } },
      });
      expect(busy.session.status().state).toBe('running');
      expect(busy.session.canResumeBrokenOriginal?.()).toBe(false);
      void run.completion.catch(() => undefined);
    } finally {
      await Promise.all([
        recoverable.session.shutdown(), drifted.session.shutdown(), noArgv.session.shutdown(),
        refused.session.shutdown(), busy.session.shutdown(),
      ]);
    }
  });

  it('records handshake capabilities on the owning agent before running the turn', async () => {
    const harness = createHarness();
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      await run.completion;
      const metadata = harness.executorContext.agent.accessor.get(ISessionMetadata);
      expect(metadata.updateAgent).toHaveBeenCalledWith(harness.executorContext.agent.id, expect.any(Function));
      const update = vi.mocked(metadata.updateAgent).mock.calls[0]![1];
      expect(update({ type: 'sub', labels: { owner: 'main' } })).toMatchObject({
        type: 'sub', labels: { owner: 'main' }, executor: 'example-acp',
        negotiated: { image: false, audio: false, fork: false, nativeSteering: false, questionForm: false, planApproval: false },
      });
      expect(metadata.registerAgent).not.toHaveBeenCalled();
    } finally { await harness.session.shutdown(); }
  });

  it('records unsupported continuation negotiation for the local catalog without starting a turn', async () => {
    const harness = createHarness();
    vi.spyOn(harness.client, 'openSession').mockRejectedValue(new AcpClientError('executor.session_open_failed', 'Cannot resume', {
      details: { resumeSupported: false, loadSupported: false },
    }));
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'Continue' }, { signal: new AbortController().signal })).rejects.toThrow('Cannot resume');
      expect(harness.executorContext.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated)
        .toHaveBeenCalledWith('example-acp', undefined, { resume: false, load: false });
      expect(harness.starts).toHaveLength(0);
    } finally { await harness.session.shutdown(); }
  });

  it.each([false, true])('requires real continuation for imported ACP sources (fingerprint mismatch: %s)', async (mismatch) => {
    const localSource = { executorId: 'example-acp', engine: 'claude', externalId: 'remote-2', home: '/vendor', localId: 'external:claude:source' };
    const harness = createHarness({ mode: 'resume', priorBindingFingerprint: mismatch ? '0'.repeat(64) : undefined,
      prior: { executorId: 'example-acp', descriptorRevision: 'r1', sessionEpoch: 1,
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2', localSource } } } });
    try {
      const run = harness.session.run({ kind: 'prompt', prompt: 'Continue' }, { signal: new AbortController().signal });
      if (mismatch) {
        await expect(run).rejects.toThrow(/fingerprint/);
        expect(harness.opens).toHaveLength(0);
        expect(harness.starts).toHaveLength(0);
      } else {
        await (await run).completion;
        expect(harness.opens[0]).toMatchObject({ requireResume: true, sessionRef: { ref: { sessionId: 'remote-2' } } });
        const updated = harness.events.filter((event) => event instanceof ExecutorSessionUpdated);
        expect(updated.length).toBeGreaterThan(0);
        expect(updated.every((event) => event.sessionRef.ref['localSource'] === localSource)).toBe(true);
      }
    } finally { await harness.session.shutdown(); }
  });

  it('opens a new ACP session when the persisted binding fingerprint differs', async () => {
    const sessionConfigOptions = configOptions().map((option) => {
      if (option.id === 'model-id' && option.type === 'select') {
        return {
          ...option,
          options: [...option.options, { value: 'model-b', name: 'Model B' }],
        };
      }
      if (option.id === 'thought-id' && option.type === 'select') {
        return {
          ...option,
          options: [...option.options, { value: 'xhigh', name: 'Extra high' }],
        };
      }
      return option;
    }) as AcpSessionConfigOption[];
    const harness = createHarness({
      mode: 'new',
      modelAlias: 'model-b',
      thinkingEffort: 'xhigh',
      priorBindingFingerprint: '0'.repeat(64),
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: {
          executorId: 'example-acp',
          version: 1,
          ref: { sessionId: 'remote-1' },
        },
        sessionEpoch: 1,
        profileDeliveredSessionId: 'remote-1',
      },
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.sessionRef).toBeUndefined();
    expect(harness.selections).toContainEqual({ configId: 'model-id', value: 'model-b' });
    expect(harness.selections).toContainEqual({ configId: 'thought-id', value: 'xhigh' });
  });

  it('passes the original Cursor alias through argv and xhigh through session config', async () => {
    const sessionConfigOptions = configOptions().map((option) =>
      option.id === 'thought-id' && option.type === 'select'
        ? {
            ...option,
            options: [...option.options, { value: 'xhigh', name: 'Extra high' }],
          }
        : option,
    ) as AcpSessionConfigOption[];
    const harness = createHarness({
      executorId: 'cursor-acp',
      modelAlias: 'cursor-fast',
      thinkingEffort: 'xhigh',
      modelBinding: 'argv',
      modelArgs: ['--model', '{model}'],
      args: ['acp'],
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    expect(resolveAcpProcessArgs(harness.executorContext)).toEqual([
      '--model',
      'cursor-fast',
      'acp',
    ]);
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.selections).not.toContainEqual({ configId: 'model-id', value: 'cursor-fast' });
    expect(harness.selections).toContainEqual({ configId: 'thought-id', value: 'xhigh' });
  });

  it.each([
    [
      'Grok session config',
      {
        executorId: 'grok-acp',
        modelAlias: 'model-a',
        thinkingEffort: 'ultra',
        modelBinding: 'session_config' as const,
      },
    ],
    [
      'Cursor argv',
      {
        executorId: 'cursor-acp',
        modelAlias: 'cursor-fast',
        thinkingEffort: 'ultra',
        modelBinding: 'argv' as const,
        modelArgs: ['--model', '{model}'],
        args: ['acp'],
      },
    ],
  ])('reports an unsupported effort for %s before starting the turn', async (_name, input) => {
    const harness = createHarness({
      ...input,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/thought level "ultra" is unavailable/);
    expect(harness.starts).toHaveLength(0);
    expect(harness.selections).not.toContainEqual({ configId: 'thought-id', value: 'low' });
    expect(harness.selections).not.toContainEqual({ configId: 'thought-id', value: 'high' });
  });

  it.each([
    ['grok-acp', 'grok'],
    ['kimi-acp', 'kimi'],
  ])('records %s completion usage with the %s provider', async (executorId, providerName) => {
    const harness = createHarness({
      executorId,
      providerName,
      completionUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const usage = {
      inputOther: 12,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({ summary: '', usage });

    expect(harness.usageRecords).toEqual([[
      'model-a',
      usage,
      { type: 'turn', turnId: 4, step: 1 },
      { provider: providerName, modelAlias: 'model-a', executorId },
    ]]);
    expect(harness.loopEvents.find(
      (event) => (event as { type?: string }).type === 'step.end',
    )).toMatchObject({ usage });
    expect(harness.events.find(
      (event) => event.type === 'turn.step.completed',
    )).toMatchObject({ usage });
  });

  it('records an explicit unknown usage fact when the executor omits completion usage', async () => {
    const harness = createHarness({
      executorId: 'kimi-acp',
      providerName: 'kimi',
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({ summary: '', usage: undefined });

    expect(harness.usageRecords).toEqual([[
      'model-a',
      { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      { type: 'turn', turnId: 4, step: 1 },
      { provider: 'kimi', modelAlias: 'model-a', executorId: 'kimi-acp', usageKnown: false },
    ]]);
  });

  it('leaves provider empty when the external model is absent from the catalog', async () => {
    const harness = createHarness({
      executorId: 'cursor-acp',
      completionUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.usageRecords[0]?.[3]).toEqual({
      provider: undefined,
      modelAlias: 'model-a',
      executorId: 'cursor-acp',
    });
  });

  it.each(['live', 'resume', 'load'] as const)('records %s resume mode without handoff', async (mode) => {
    const harness = createHarness({
      mode,
      loadReplayObserved: mode === 'load',
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: {
          executorId: 'example-acp',
          version: 1,
          ref: { sessionId: 'remote-2' },
        },
        profileDeliveredSessionId: 'remote-2',
      },
      events: [
        {
          type: 'message.delta',
          role: 'assistant',
          messageId: 'live-only',
          content: { type: 'text', text: 'live' },
        },
      ],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata).toMatchObject({ resumeMode: mode });
    expect(metadata?.losses).not.toContain('resume_new_session_handoff');
    expect(harness.loopEvents.filter(
      (event) => (event as { type?: string }).type === 'content.part',
    )).toHaveLength(1);
  });

  it.each(['live', 'resume', 'load'] as const)('records the current %s opening mode instead of the cached configuration mode', async (mode) => {
    const harness = createHarness({ mode });
    const configure = harness.client.configureSession;
    vi.spyOn(harness.client, 'configureSession').mockImplementation(async (input) => ({ ...await configure(input), mode: 'new' }));
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'continue' }, { signal: new AbortController().signal });
      await run.completion;
      const metadata = harness.events.find((event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata);
      expect(metadata).toMatchObject({ resumeMode: mode });
      expect(metadata?.losses).not.toContain('resume_new_session_handoff');
    } finally { await harness.session.shutdown(); }
  });

  it.each(['grok-acp', 'claude-acp'] as const)('resumes an unpinned %s session with the harness default model', async (executorId) => {
    const harness = createHarness({
      executorId, unpinModel: true, thinkingEffort: 'off', mode: 'resume',
      prior: {
        executorId, descriptorRevision: 'r1',
        sessionRef: { executorId, version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
    });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'Continue' },
      { signal: new AbortController().signal });
    await run.completion;
    expect(harness.selections).not.toContainEqual({ configId: 'model-id', value: 'model-a' });
    expect(harness.events.find((event) => event instanceof ExecutorTurnMetadata))
      .toMatchObject({ executorId, resumeMode: 'resume' });
    expect(harness.usageRecords[0]?.[3]).toMatchObject({ modelAlias: undefined, executorId });
    await harness.session.shutdown();
  });

  it.each([
    [
      'missing selected value even when currentValue matches',
      [
        {
          id: 'model-id',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'model-a',
          options: [{ value: 'other', name: 'Other' }],
        },
      ] as AcpSessionConfigOption[],
      undefined,
    ],
    [
      'ambiguous model category',
      [
        ...configOptions(false),
        {
          id: 'model-id-2',
          name: 'Model 2',
          category: 'model',
          type: 'select',
          currentValue: 'model-a',
          options: [{ value: 'model-a', name: 'Model A' }],
        },
      ] as AcpSessionConfigOption[],
      undefined,
    ],
    ['set_config_option failure', configOptions(false), 'model-id'],
  ])('fails model selection closed for %s', async (_name, sessionConfigOptions, configureFailureId) => {
    const harness = createHarness({
      sessionConfigOptions,
      configureFailureId,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    await expect(
      harness.session.run(
        { kind: 'prompt', prompt: 'work' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
    expect(harness.starts).toHaveLength(0);
  });

  it('builds deterministic bounded handoff for new-session fallback', async () => {
    const history: ContextMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `prompt-${index}-${'x'.repeat(5_000)}` }],
      toolCalls: [],
    }));
    const prior = {
      executorId: 'example-acp',
      descriptorRevision: 'r1',
      sessionRef: {
        executorId: 'example-acp',
        version: 1,
        ref: { sessionId: 'remote-1' },
      },
      profileDeliveredSessionId: 'remote-1',
    };
    const harness = createHarness({
      history,
      prior,
      mode: 'new',
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const first = buildHandoff(history);
    const second = buildHandoff(history);
    expect(first).toEqual(second);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(first.truncated).toBe(true);

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    expect(harness.starts[0]?.prompt).toContain('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF');
    expect(harness.starts[0]?.prompt).toContain('BEGIN KIKI FROZEN PROFILE INSTRUCTIONS');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata).toMatchObject({ resumeMode: 'handoff' });
    expect(metadata?.losses).toEqual(expect.arrayContaining([
      'resume_new_session_handoff',
      'handoff_truncated',
    ]));
  });

  it('retains the handoff but not the profile preamble when resume falls back to a new override session', async () => {
    const harness = createHarness({
      mode: 'new',
      profileDelivery: 'system_prompt_override',
      history: [{ role: 'user', content: [{ type: 'text', text: 'previous request' }], toolCalls: [] }],
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-1' } },
        profileDeliveredSessionId: 'remote-1',
        profileDelivery: 'first_prompt_preamble',
      },
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'continue' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.opens[0]?.systemPromptOverride).toBe('Frozen profile');
    expect(harness.starts[0]?.prompt).toContain('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF');
    expect(harness.starts[0]?.prompt).not.toContain('BEGIN KIKI FROZEN PROFILE INSTRUCTIONS');
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata).toMatchObject({ resumeMode: 'handoff', profileDelivery: 'system_prompt_override' });
    expect(metadata?.losses).toContain('resume_new_session_handoff');
    expect(metadata?.losses).not.toContain('profile_as_user_preamble');
  });

  it.each(['permission', 'elicitation', 'plan'] as const)(
    'keeps sibling approvals pending while an active ACP turn cancels one %s request', async (kind) => {
      const ix = new TestInstantiationService();
      ix.set(ISessionStateService, new SessionStateService());
      ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
      ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
      const interaction = ix.get(ISessionInteractionService);
      const approvals = ix.get(ISessionApprovalService);
      interaction.acquireConsumer('test');
      const harness = createHarness({ deferTurnCompletion: true,
        elicitation: kind === 'elicitation' ? { mode: 'form', sessionId: 'remote-2', message: 'Allow?',
          requestedSchema: { type: 'object', properties: {} } } : undefined,
        planApproval: kind === 'plan' ? { sessionId: 'remote-2', toolCallId: 'exit-plan', plan: '# Plan' } : undefined,
      });
      vi.spyOn(harness.interaction, 'cancelPendingForTurn').mockImplementation((turnId, agentId) => interaction.cancelPendingForTurn(turnId, agentId));
      const request = vi.spyOn(harness.approval, 'request').mockImplementation((req) => {
        if ((kind === 'permission' && request.mock.calls.length !== 1) ||
            (kind !== 'permission' && request.mock.calls.length === 1)) {
          return Promise.resolve({ decision: 'approved', selectedOptionId: 'allow-once' });
        }
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
        expect(interaction.listPending().map((entry) => entry.id)).toEqual(['sibling']);
        expect(harness.interaction.cancelPendingForTurn).not.toHaveBeenCalled();
        await harness.session.shutdown();
        expect(interaction.listPending()).toEqual([]);
      } finally {
        await harness.session.shutdown();
        await ix.dispose();
      }
    },
  );

  it.each([
    ['unknown option', async () => ({ decision: 'approved', selectedOptionId: 'unknown' } as ApprovalResponse)],
    ['no consumer', undefined],
  ])('fails permission closed for %s', async (_name, approval) => {
    const harness = createHarness({ approval });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    expect(harness.permissionDecisions).toEqual([{ outcome: 'cancelled' }]);
  });

  it('fails permission closed when the permission request disconnects', async () => {
    const controller = new AbortController();
    const harness = createHarness({
      permissionSignal: controller,
      approval: () => new Promise<ApprovalResponse>(() => {}),
    });
    queueMicrotask(() => controller.abort(new Error('disconnected')));
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    expect(harness.permissionDecisions).toEqual([{ outcome: 'cancelled' }]);
    expect(harness.interaction.cancelPendingForTurn).toHaveBeenCalled();
  });

  it.each([
    ['missing surface', { permissionSurface: false }],
    ['setting failure', { configureFailureId: 'auto_approve' }],
    ['readback mismatch', { configureReadbackFailureId: 'auto_approve' }],
    [
      'ambiguous surface',
      {
        sessionConfigOptions: [
          ...configOptions(),
          {
            id: 'auto_approve_2',
            name: 'Auto approve 2',
            category: 'mode',
            type: 'boolean',
            currentValue: true,
          },
        ] as AcpSessionConfigOption[],
        permissionMapping: {
          configCategory: 'mode',
          manual: false,
          auto: false,
          yolo: true,
        },
      },
    ],
  ])('fails manual permission mode closed for %s', async (_name, options) => {
    const harness = createHarness({
      ...options, permissionMode: 'manual',
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow();
    expect(harness.starts).toHaveLength(0);
  });

  it.each([['read', 'Read', 'read'], ['edit', 'Write', 'write']] as const)(
    'projects standard ACP %s kind and locations rather than its human title without private metadata', async (kind, name, operation) => {
      const permissionGate = vi.fn<IAgentPermissionGate['authorize']>(async (context) => {
        expect(context.toolCall.name).toBe(name);
        expect(context.execution.accesses).toEqual([
          { kind: 'file', operation, path: 'C:/workspace/blocked.ts', implicitExternal: false },
        ]);
        expect(context.execution.matchesRule?.('C:/workspace/blocked.ts', 'any')).toBe(true);
        return { permissionDecision: 'rejected', veto: { isError: true, output: 'Explicit path deny' } };
      });
      const approval = vi.fn(async () => ({ decision: 'approved' as const, selectedOptionId: 'allow-once' }));
      const harness = createHarness({ permissionMode: 'yolo', approval, permissionGate,
        permissionToolCall: { toolCallId: 'standard-call', kind, title: `${name} C:/workspace/blocked.ts`,
          status: 'pending', locations: [{ path: 'C:/workspace/blocked.ts' }] } });
      const run = await harness.session.run({ kind: 'prompt', prompt: 'neutral fixture' }, { signal: new AbortController().signal });
      await run.completion;
      expect(permissionGate).toHaveBeenCalledTimes(1);
      expect(approval).not.toHaveBeenCalled();
      expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
      await harness.session.shutdown();
    },
  );

  it.each(['manual', 'auto', 'yolo'] as const)('inherits vendor mode without an override despite ambient %s', async (permissionMode) => {
    const approval = vi.fn(async () => ({ decision: 'approved' as const, selectedOptionId: 'allow-once' }));
    const harness = createHarness({ permissionMode, inheritPermission: true, vendorDefaultOption: true, approval });
    const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    await run.completion;
    expect(harness.selections.some((selection) => selection.configId === 'auto_approve')).toBe(false);
    expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'kiki.vendor_default' }]);
    expect(approval).not.toHaveBeenCalled();
    expect(harness.starts[0]?.session?.sessionMeta?.['kiki.permission']).toMatchObject({ override: undefined, hostGate: false });
  });

  it.each([false, true])('restores vendor permission value after clearing a runtime override (cold=%s)', async (cold) => {
    const harness = createHarness({ permissionMode: 'yolo', vendorDefaultOption: true, mode: 'resume',
      sessionConfigOptions: configOptions(true, false) });
    const first = await harness.session.run({ kind: 'prompt', prompt: 'first' }, { signal: new AbortController().signal });
    await first.completion;
    await harness.session.settled();
    expect(harness.state.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toEqual({
      sessionId: 'remote-2', config: { configId: 'auto_approve', value: false },
    });
    Object.assign(harness.permissionMode, { externalOverride: undefined });
    const session = cold ? harness.createSession(harness.executorContext) : harness.session;
    try {
      const next = await session.run({ kind: 'prompt', prompt: 'next' }, { signal: new AbortController().signal });
      await next.completion;
      expect(harness.selections.filter((selection) => selection.configId === 'auto_approve')).toEqual([
        { configId: 'auto_approve', value: true }, { configId: 'auto_approve', value: false },
      ]);
      expect(harness.state.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toBeUndefined();
      expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'allow-once' },
        { outcome: 'selected', optionId: 'kiki.vendor_default' }]);
      expect(harness.starts[1]?.session?.sessionMeta?.['kiki.permission']).toMatchObject({ override: undefined, hostGate: false });
    } finally { await session.shutdown(); await harness.session.shutdown(); }
  });

  it('persists the vendor baseline before permission configuration can fail', async () => {
    const options: FakeHarnessOptions = { permissionMode: 'yolo', vendorDefaultOption: true,
      mode: 'resume', configureFailureId: 'auto_approve',
      sessionConfigOptions: configOptions(true, false) };
    const harness = createHarness(options);
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'first' }, { signal: new AbortController().signal })).rejects.toThrow('set_config_option failed');
      expect(harness.state.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toEqual({
        sessionId: 'remote-2', config: { configId: 'auto_approve', value: false },
      });
      Object.assign(options, { configureFailureId: undefined });
      Object.assign(harness.permissionMode, { externalOverride: undefined });
      const cold = harness.createSession(harness.executorContext);
      try {
        await (await cold.run({ kind: 'prompt', prompt: 'recover' }, { signal: new AbortController().signal })).completion;
        expect(harness.selections).toContainEqual({ configId: 'auto_approve', value: false });
        expect(harness.state.get(externalExecutorKey).sessionRef?.ref['kikiPermissionRestore']).toBeUndefined();
      } finally { await cold.shutdown(); }
    } finally { await harness.session.shutdown(); }
  });

  it.each([
    ['auto', false],
    ['yolo', true],
  ] as const)('applies the declared explicit %s permission mapping without artificial constraints', async (permissionMode, value) => {
    const harness = createHarness({
      permissionMode,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;
    expect(harness.selections).toContainEqual({ configId: 'auto_approve', value });
  });

  it('keeps permission callbacks when an explicit deny constrains YOLO', async () => {
    const harness = createHarness({ permissionMode: 'yolo', permissionGate: async () => ({
      permissionDecision: 'rejected', veto: { isError: true, output: 'Explicit deny' },
    }) });
    Object.assign(harness.executorContext.binding, { disallowedTools: ['blocked_tool'] });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      await run.completion;
      expect(harness.selections).toContainEqual({ configId: 'auto_approve', value: false });
      expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    } finally { await harness.session.shutdown(); }
  });

  it.each([
    ['manual', 'default'],
    ['auto', 'auto'],
    ['yolo', 'yolo'],
  ] as const)('configures Kimi ACP for explicit %s before starting the turn', async (permissionMode, value) => {
    const harness = createHarness({
      permissionMode,
      permissionMapping: BUILTIN_AGENT_EXECUTORS['kimi-acp']!.permissionModeMapping,
      sessionConfigOptions: [
        ...configOptions(false),
        buildModeOption('default'),
      ],
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.selections).toContainEqual({ configId: 'mode', value });
    expect(harness.starts).toHaveLength(1);
  });

  it.each(['sub', 'independent'] as const)('sends the saved cold %s identity through the ACP preamble', async (position) => {
    const harness = createExecutionHarness();
    const adapter = harness.ix.get(IAgentProfileService);
    const cold = await coldPromptFixture(position, adapter.data(), harness.ix.get(IAgentExecutorRegistry));
    vi.spyOn(adapter, 'data').mockImplementation(() => cold.profile.data());
    vi.spyOn(adapter, 'preparePromptConfiguration').mockImplementation(() => cold.profile.preparePromptConfiguration());
    vi.spyOn(adapter, 'getSystemPrompt').mockImplementation(() => cold.profile.getSystemPrompt());
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      const sent = JSON.stringify(harness.starts[0]);
      expect(harness.starts[0]?.prompt).toContain(cold.before.systemPrompt);
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
    'cancels a deferred ACP turn and closes the real DI-owned session during %s',
    async (close) => {
      const harness = createExecutionHarness();
      const errors = vi.spyOn(console, 'error');
      const executionDispose = vi.spyOn(harness.execution, 'dispose');
      try {
        const run = await harness.execution.run(
          { kind: 'prompt', prompt: 'work' },
          { signal: new AbortController().signal },
        );
        expect(JSON.stringify(harness.starts[0])).toContain('Frozen profile');
        expect(JSON.stringify(harness.starts[0])).not.toContain('ALL_EXECUTORS_SHARED');
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
        expect(harness.interaction.cancelPendingForTurn).toHaveBeenCalledWith(run.turn.id, 'external-agent');
        expect(harness.client.shutdown).toHaveBeenCalledTimes(1);
        expect(harness.runtimeLease.dispose).toHaveBeenCalledTimes(1);
        expect(harness.execution.status()).toEqual({ state: 'closed' });
      } finally {
        await harness.ix.dispose();
        await harness.execution.shutdown();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      }
    },
  );

  it('skips thought configuration with a loss when the harness exposes no thought surface', async () => {
    const sessionConfigOptions = [
      ...configOptions(false).filter((option) => option.id !== 'thought-id'),
      ...configOptions().filter((option) => option.id === 'auto_approve'),
    ];
    const harness = createHarness({
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.starts).toHaveLength(1);
    expect(harness.selections).toContainEqual({ configId: 'model-id', value: 'model-a' });
    expect(harness.selections).not.toContainEqual({ configId: 'thought-id', value: 'high' });
    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.losses).toEqual(expect.arrayContaining(['thought_level_unconfigured']));
  });

  it('fails thought selection closed when the thought category is ambiguous', async () => {
    const sessionConfigOptions: AcpSessionConfigOption[] = [
      ...configOptions(false),
      {
        id: 'thought-id-2',
        name: 'Thought 2',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ];
    const harness = createHarness({
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/ambiguous/);
    expect(harness.starts).toHaveLength(0);
  });

  it('uses the sole uncategorized select as the thought config when no category matches', async () => {
    const sessionConfigOptions: AcpSessionConfigOption[] = [
      ...configOptions(false).filter((option) => option.id !== 'thought-id'),
      ...configOptions().filter((option) => option.id === 'auto_approve'),
      {
        id: 'brain',
        name: 'Brain',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ];
    const harness = createHarness({
      sessionConfigOptions,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.selections).toContainEqual({ configId: 'brain', value: 'high' });
  });

  it('resolves an ambiguous thought config through the explicit descriptor config id', async () => {
    const uncategorized = (id: string): AcpSessionConfigOption => ({
      id,
      name: id,
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    });
    const sessionConfigOptions: AcpSessionConfigOption[] = [
      ...configOptions(false).filter((option) => option.id !== 'thought-id'),
      ...configOptions().filter((option) => option.id === 'auto_approve'),
      uncategorized('brain-1'),
      uncategorized('brain-2'),
    ];
    const harness = createHarness({
      sessionConfigOptions,
      thoughtConfigId: 'brain-2',
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    expect(harness.selections).toContainEqual({ configId: 'brain-2', value: 'high' });
    expect(harness.selections).not.toContainEqual({ configId: 'brain-1', value: 'high' });
  });

  it.each(['manual', 'auto', 'yolo'] as const)('diagnoses unsupported explicit %s without starting a turn', async (permissionMode) => {
    const harness = createHarness({ permissionMapping: null, permissionMode });
    try {
      await expect(harness.session.run({ kind: 'prompt', prompt: 'work' },
        { signal: new AbortController().signal })).rejects.toThrow(`cannot verify ${permissionMode} permission mode`);
      expect(harness.starts).toHaveLength(0);
    } finally { await harness.session.shutdown(); }
  });

  it.each(['new', 'load'] as const)('applies an explicit host gate receipt on %s without changing the saved descriptor', async (mode) => {
    const authorize = vi.fn<IAgentPermissionGate['authorize']>(async (context) => context.toolCall.name === 'TaskList'
      ? { veto: { isError: true, output: 'Explicit deny' }, permissionDecision: 'rejected' } : undefined);
    const harness = createHarness({ mode, permissionMapping: null, permissionMode: 'yolo',
      prior: mode === 'load' ? { executorId: 'example-acp', descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } } } : undefined,
      hostPermissionReceipt: (input) => ({ 'kiki.permission': { version: 1, sessionId: 'remote-2', openMode: mode,
        gate: 'pre-tool-hook', applied: JSON.parse(JSON.stringify(input.sessionMeta?.['kiki.permission'])) } }),
      permissionToolCall: { toolCallId: 'native-task', title: 'manage_task', kind: 'read', rawInput: { Action: 'list' } },
      permissionRequestMeta: { 'kiki.tool': { name: 'TaskList', nativeName: 'manage_task', input: { Action: 'list' } } },
      permissionGate: authorize,
    });
    try {
      const turn = await harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      await turn.completion;
      expect(harness.starts).toHaveLength(1);
      expect(harness.permissionDecisions).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
      expect(authorize.mock.calls.map(([context]) => context.toolCall.name)).toEqual(['manage_task', 'TaskList']);
      expect(harness.opens[0]?.sessionMeta?.['kiki.permission']).toMatchObject({ override: { mode: 'yolo', source: 'runtime' }, hostGate: true });
      expect(harness.events.filter((event) => event instanceof ExecutorSessionUpdated).every((event) => event.descriptorRevision === 'r1')).toBe(true);
    } finally { await harness.session.shutdown(); }
  });

  it.each(['session', 'mode', 'source', 'policy', 'workspace', 'restriction', 'extra', 'nonce', 'gate', 'version', 'openMode', 'missing'] as const)(
    'rejects an unapplied or mismatched host gate receipt: %s', async (mismatch) => {
      const harness = createHarness({ mode: 'load', permissionMapping: null, permissionMode: 'yolo',
        hostPermissionReceipt: (input) => {
          const applied = JSON.parse(JSON.stringify(input.sessionMeta?.['kiki.permission'])) as Record<string, unknown>;
          const receipt: Record<string, unknown> = { version: 1, sessionId: 'remote-2', openMode: 'load', gate: 'pre-tool-hook', applied };
          if (mismatch === 'missing') return undefined;
          if (mismatch === 'session') receipt['sessionId'] = 'other-session';
          if (mismatch === 'mode') applied['override'] = { mode: 'auto', source: 'runtime' };
          if (mismatch === 'source') applied['override'] = { mode: 'yolo', source: 'ambient' };
          if (mismatch === 'policy') applied['policyIdentity'] = 'other-policy';
          if (mismatch === 'workspace') applied['workspace'] = { cwd: '/other', additionalDirectories: [] };
          if (mismatch === 'restriction') applied['restriction'] = { kind: 'unexpected-restriction' };
          if (mismatch === 'extra') applied['unexpected'] = true;
          if (mismatch === 'nonce') applied['requestId'] = 'previous-load';
          if (mismatch === 'gate') receipt['gate'] = 'echo-only';
          if (mismatch === 'version') receipt['version'] = 2;
          if (mismatch === 'openMode') receipt['openMode'] = 'new';
          return { 'kiki.permission': receipt };
        },
      });
      try {
        await expect(harness.session.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal })).rejects.toThrow('cannot verify yolo');
        expect(harness.starts).toHaveLength(0);
      } finally { await harness.session.shutdown(); }
    },
  );

  it('records dropped additional directories when the harness does not declare support for them', async () => {
    const harness = createHarness({
      capabilities: {},
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await run.completion;

    const metadata = harness.events.find(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata?.losses).toEqual(expect.arrayContaining(['additional_directories_dropped']));
  });

  it('uses pinned agent roots in ACP open options without changing the parent session cwd', async () => {
    const harness = createHarness({
      capabilities: { sessionCapabilities: { additionalDirectories: {} } },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    Object.assign(harness.workspace, { workDir: 'C:\\parent', additionalDirs: ['C:\\parent-shared'] });
    Object.assign(harness.runtime, {
      workspaceRoots: () => ({
        workDir: 'C:\\worktrees\\child',
        additionalDirs: ['C:\\materials\\review', 'C:\\materials\\profiles'],
      }),
    });
    for (const prompt of ['work', 'continue']) {
      const run = await harness.session.run({ kind: 'prompt', prompt }, { signal: new AbortController().signal });
      await run.completion;
      await harness.session.settled();
    }
    expect(harness.workspace.workDir).toBe('C:\\parent');
    expect(harness.opens).toHaveLength(2);
    for (const opened of harness.opens) {
      expect(opened.cwd).toBe('C:\\worktrees\\child');
      expect(opened.additionalDirectories).toEqual(['C:\\materials\\review', 'C:\\materials\\profiles']);
      expect(opened.sessionMeta?.['kiki.permission']).toMatchObject({ workspace: {
        cwd: 'C:\\worktrees\\child', additionalDirectories: ['C:\\materials\\review', 'C:\\materials\\profiles'],
      } });
    }
    expect(harness.opens[0]?.sessionRef).toBeUndefined();
    expect(harness.opens[1]?.sessionRef?.ref).toEqual({ sessionId: 'remote-2' });
    const metadata = harness.events.filter(
      (event): event is ExecutorTurnMetadata => event instanceof ExecutorTurnMetadata,
    );
    expect(metadata).toHaveLength(2);
    for (const event of metadata) expect(event.losses).not.toContain('additional_directories_dropped');
    await harness.session.shutdown();
  });

  it('attributes resumed-session usage as a delta of the persisted cumulative counters', async () => {
    const harness = createHarness({
      mode: 'resume',
      providerName: 'kimi',
      completionUsage: {
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 25,
        thoughtTokens: 3,
        cachedReadTokens: 4,
        cachedWriteTokens: 2,
      },
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
        lastCumulativeUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({
      summary: '',
      usage: { inputOther: 5, output: 4, inputCacheRead: 4, inputCacheCreation: 2 },
    });

    expect(harness.usageRecords).toEqual([[
      'model-a',
      { inputOther: 5, output: 4, inputCacheRead: 4, inputCacheCreation: 2 },
      { type: 'turn', turnId: 4, step: 1 },
      { provider: 'kimi', modelAlias: 'model-a', executorId: 'example-acp' },
    ]]);
    const updates = harness.events.filter(
      (event): event is ExecutorSessionUpdated => event instanceof ExecutorSessionUpdated,
    );
    expect(updates.at(-1)).toMatchObject({
      lastCumulativeUsage: {
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 25,
        thoughtTokens: 3,
        cachedReadTokens: 4,
        cachedWriteTokens: 2,
      },
    });
  });

  it('reports usage unknown instead of charging historical tokens when counters reset', async () => {
    const harness = createHarness({
      mode: 'resume',
      providerName: 'kimi',
      completionUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
        lastCumulativeUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({ summary: '', usage: undefined });

    expect(harness.usageRecords).toEqual([[
      'model-a',
      { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      { type: 'turn', turnId: 4, step: 1 },
      { provider: 'kimi', modelAlias: 'model-a', executorId: 'example-acp', usageKnown: false },
    ]]);
  });

  it('reports usage unknown for a resumed session without a persisted cumulative baseline', async () => {
    const harness = createHarness({
      mode: 'resume',
      providerName: 'kimi',
      completionUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
        profileDeliveredSessionId: 'remote-2',
      },
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });

    const run = await harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );
    await expect(run.completion).resolves.toEqual({ summary: '', usage: undefined });

    expect(harness.usageRecords[0]?.[3]).toMatchObject({ usageKnown: false });
  });
});


describe('ACP product interaction mapping', () => {
  it('routes a blocking form through the durable question service with the active turn and remote tool identity', async () => {
    const harness = createHarness({ executorId: 'codex-acp', questionResponse: { Strategy: 'Safe' }, elicitation: {
      mode: 'form', sessionId: 'remote-2', toolCallId: 'ask-1', message: 'Pick a strategy', requestedSchema: {
        type: 'object', required: ['strategy'], properties: { strategy: { type: 'string', title: 'Strategy', oneOf: [{ const: 'safe', title: 'Safe' }, { const: 'fast', title: 'Fast' }] } },
      },
    } });
    try {
      const handle = await harness.session.run({ kind: 'prompt', prompt: 'Plan the task' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.question.request).toHaveBeenCalledWith({ turnId: handle.turn.id,
        toolCallId: expect.stringContaining('ask-1'), questions: [{ question: 'Strategy', body: undefined,
          options: [{ label: 'Safe' }, { label: 'Fast' }], multiSelect: false, otherLabel: undefined }] },
      { signal: expect.any(AbortSignal), agentId: 'external-agent' });
      expect(harness.elicitationDecisions).toEqual([{ action: 'accept', content: { strategy: 'safe' } }]);
    } finally { await harness.session.shutdown(); }
  });

  it('does not approve an elicitation addressed to a different remote session', async () => {
    const harness = createHarness({ elicitation: { mode: 'form', sessionId: 'unrelated', message: 'Approve', requestedSchema: { type: 'object', properties: {} } } });
    try {
      const handle = await harness.session.run({ kind: 'prompt', prompt: 'Hello' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.elicitationDecisions).toEqual([{ action: 'decline' }]);
      expect(harness.question.request).not.toHaveBeenCalled();
    } finally { await harness.session.shutdown(); }
  });

  it('maps Grok plan approval into the existing plan-review card and uses the donor outcome field', async () => {
    const harness = createHarness({ executorId: 'grok-acp', planApproval: { sessionId: 'remote-2', toolCallId: 'exit-plan', plan: '# Plan\n- Inspect' },
      approval: async () => ({ decision: 'approved' }) });
    try {
      const handle = await harness.session.run({ kind: 'prompt', prompt: 'Plan' }, { signal: new AbortController().signal });
      await handle.completion;
      expect(harness.approvalRequests.at(-1)).toMatchObject({ turnId: handle.turn.id, display: { kind: 'plan_review', plan: '# Plan\n- Inspect' } });
      expect(harness.planDecisions).toEqual([{ outcome: 'approved', feedback: '' }]);
    } finally { await harness.session.shutdown(); }
  });
});

describe('ACP MCP approval scope', () => {
  it('preserves donor once/session/always scope values rather than coercing them to a boolean', async () => {
    const harness = createHarness({ executorId: 'codex-acp', approval: async () => ({ decision: 'approved', selectedOptionId: 'session' }),
      elicitation: { mode: 'form', sessionId: 'remote-2', message: 'Allow tool?', _meta: { codex_approval_kind: 'mcp_tool_call' },
        requestedSchema: { type: 'object', required: ['persist'], properties: { persist: { type: 'string', oneOf: [
          { const: 'once', title: 'Allow once' }, { const: 'session', title: 'Allow for this session' }, { const: 'always', title: 'Allow always' },
        ] } } } } });
    try {
      const run = await harness.session.run({ kind: 'prompt', prompt: 'List' }, { signal: new AbortController().signal });
      await run.completion;
      expect(harness.elicitationDecisions).toEqual([{ action: 'accept', content: { persist: 'session' } }]);
    } finally { await harness.session.shutdown(); }
  });
});


describe('external Memory working-set delivery', () => {
  it.each([true, false])('captures the actual ACP request with explicit memory admission=%s', async (admitted) => {
    const harness = createExecutionHarness({ unpinModel: true, thinkingEffort: 'off' });
    const profile = harness.ix.get(IAgentProfileService);
    const original = profile.data();
    const execution = resolveExecutionBinding({ executor: original.executorId!, overrides: { kiki_context: admitted ? ['memory'] : [], inject_kiki_mcp: false } }, undefined, undefined, undefined);
    vi.spyOn(profile, 'data').mockReturnValue({ ...original, execution, systemPrompt: '', kikiContext: admitted ? ['memory'] : [] });
    const projection = '<memory-workset generation=2>\nUse exactly 17 jobs. Never upload; isolated tests excepted.\n</memory-workset>';
    const refresh = vi.fn(async () => projection);
    harness.ix.stub(IAgentMemorySnapshot, { refreshIfDirty: refresh, get: async () => projection });
    try {
      await harness.execution.run({ kind: 'prompt', prompt: 'Compilation policy' }, { signal: new AbortController().signal });
      const actual = harness.starts[0]?.prompt;
      if (admitted) {
        expect(refresh).toHaveBeenCalledWith('Compilation policy');
        expect(actual).toContain(projection);
        expect(actual).toContain('Compilation policy');
        expect(harness.events.filter((event) => event instanceof ExecutorHintDelivery)).toContainEqual(expect.objectContaining({ origin: 'memory_workset', method: 'next_turn_preamble', status: 'delivered' }));
      } else {
        expect(refresh).not.toHaveBeenCalled();
        expect(actual).toBe('Compilation policy');
        expect(harness.events.filter((event) => event instanceof ExecutorHintDelivery)).not.toContainEqual(expect.objectContaining({ origin: 'memory_workset' }));
      }
    } finally { await harness.execution.shutdown(); await harness.ix.dispose(); }
  });
});
