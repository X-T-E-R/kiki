import type {
  AcpOpenSessionOptions,
  AcpOpenSessionResult,
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpSessionConfigOption,
  AcpTurnHandle,
  AcpTurnRequest,
  AcpTurnResult,
  NormalizedExecutorEvent,
} from '@kiki/acp-client';
import { describe, expect, it, vi } from 'vitest';
import { coldPromptFixture } from './coldPromptFixture';

import { buildModeOption } from '../../../../acp-server/src/config-options';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
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
  ExecutorPlanUpdate,
  ExecutorRuntimeUpdate,
  ExecutorSessionUpdated,
  ExecutorTurnMetadata,
  externalExecutorKey,
} from '#/agent/execution/externalExecutorOps';
import { ExternalTurnRecorder } from '#/agent/execution/externalTurnRecorder';
import { TurnPrompt, turnKey } from '#/agent/loop/turnOps';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentUsageService } from '#/agent/usage/usage';
import {
  agentExecutorBindingFingerprint,
  IAgentExecutorRegistry,
  type AgentExecutorContext,
} from '#/app/agentExecutor/agentExecutor';
import { BUILTIN_AGENT_EXECUTORS } from '#/app/agentExecutor/builtinDescriptors';
import type { Event2 } from '#/app/event/event2';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ISessionApprovalService, type ApprovalResponse } from '#/session/approval/approval';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';

interface FakeHarnessOptions {
  readonly mode?: AcpOpenSessionResult['mode'];
  readonly events?: readonly NormalizedExecutorEvent[];
  readonly history?: readonly ContextMessage[];
  readonly prior?: ReturnType<typeof stateHarness>['prior'];
  readonly approval?: () => Promise<ApprovalResponse>;
  readonly permissionSignal?: AbortController;
  readonly loadReplayObserved?: boolean;
  readonly permissionSurface?: boolean;
  readonly sessionConfigOptions?: readonly AcpSessionConfigOption[];
  readonly configureFailureId?: string;
  readonly configureReadbackFailureId?: string;
  readonly permissionMode?: 'manual' | 'auto' | 'yolo';
  readonly permissionMapping?: AgentExecutorContext['descriptor']['permissionModeMapping'];
  readonly completionUsage?: AcpTurnResult['response']['usage'];
  readonly executorId?: string;
  readonly providerName?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly modelBinding?: 'session_config' | 'argv';
  readonly modelArgs?: readonly string[];
  readonly args?: readonly string[];
  readonly priorBindingFingerprint?: string;
  readonly deferTurnCompletion?: boolean;
}

function asyncEvents(events: readonly NormalizedExecutorEvent[]): AsyncIterable<NormalizedExecutorEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function configOptions(permissionSurface = true): AcpSessionConfigOption[] {
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
      currentValue: true,
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
} = {}) {
  const values = new Map<unknown, unknown>([
    [turnKey, { nextTurnId: 4, cancelledTurnIds: [] }],
    [externalExecutorKey, prior],
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

function createHarness(options: FakeHarnessOptions = {}) {
  const events: Event2[] = [];
  const loopEvents: unknown[] = [];
  const appendedMessages: ContextMessage[] = [];
  const starts: AcpTurnRequest[] = [];
  const opens: AcpOpenSessionOptions[] = [];
  const selections: Array<{ configId: string; value: string | boolean }> = [];
  const permissionDecisions: AcpPermissionDecision[] = [];
  const state = stateHarness(options.prior);
  const wire = {
    _serviceBrand: undefined,
    flush: vi.fn(async () => {}),
  } as unknown as IWireService;
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: async (event: Event2) => {
      events.push(event);
      if (event instanceof TurnPrompt) {
        state.values.set(turnKey, { nextTurnId: event.turnId! + 1, cancelledTurnIds: [] });
      }
      if (event instanceof ExecutorSessionUpdated) {
        state.values.set(externalExecutorKey, {
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
  const contextMemory = {
    _serviceBrand: undefined,
    get: () => options.history ?? [],
    append: (...messages: readonly ContextMessage[]) => appendedMessages.push(...messages),
    appendLoopEvent: (event: unknown) => loopEvents.push(event),
  } as unknown as IAgentContextMemoryService;
  const approval = {
    _serviceBrand: undefined,
    request: async () => {
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
  const services = new Map<unknown, unknown>([
    [IAgentStateService, state.state],
    [IModelCatalog, modelCatalog],
    [IAgentUsageService, usage],
    [IEventDispatcher, dispatcher],
    [IWireService, wire],
    [IAgentContextMemoryService, contextMemory],
    [ISessionApprovalService, approval],
    [ISessionInteractionService, interaction],
    [IAgentRuntimeService, runtime],
    [ISessionWorkspaceContext, workspace],
    [IAgentPermissionModeService, permissionMode],
  ]);
  let permissionHandler: AcpPermissionHandler | undefined;
  let configured = options.sessionConfigOptions === undefined
    ? configOptions(options.permissionSurface !== false)
    : [...options.sessionConfigOptions];
  const openResult = (): AcpOpenSessionResult => ({
    sessionId: 'remote-2',
    mode: options.mode ?? 'new',
    initialize: {} as AcpOpenSessionResult['initialize'],
    capabilities: {},
    configOptions: configured,
    sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-2' } },
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
    status: () => ({ state: 'ready' as const, sessionId: 'remote-2' }),
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
            toolCall: {
              toolCallId: 'permission-tool',
              title: 'Apply patch',
              status: 'pending',
              rawInput: { path: 'src/a.ts' },
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
          {
            signal,
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        );
        permissionDecisions.push(decision);
      }
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
      id: 'external-agent',
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
      modelArgs: options.modelArgs,
      modelConfigCategory: 'model',
      thoughtConfigCategory: 'thought_level',
      permissionModeMapping: options.permissionMapping ?? {
        configId: 'auto_approve',
        manual: false,
        auto: false,
        yolo: true,
      },
      revision: 'r1',
    },
    binding: {
      modelAlias: options.modelAlias ?? 'model-a',
      thinkingLevel: options.thinkingEffort ?? 'high',
      systemPrompt: 'Frozen profile',
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
    (_process, handler) => {
      permissionHandler = handler;
      return client;
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
    interaction,
    pendingTurns,
    runtime,
    runtimeLease,
    workspace,
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

function createExecutionHarness(options: FakeHarnessOptions = {}) {
  const harness = createHarness({ ...options, deferTurnCompletion: true });
  const ix = new TestInstantiationService();
  const agentId = harness.executorContext.agent.id;
  ix.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
  ix.set(IAgentContextMemoryService, harness.contextMemory);
  ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
  ix.set(IAgentExecutorRegistry, {
    resolveExecutable: async () => ({
      descriptor: harness.executorContext.descriptor,
      options: {},
      provider: { create: harness.createSession },
    }),
  } as unknown as IAgentExecutorRegistry);
  ix.set(IAgentPermissionModeService, harness.permissionMode);
  ix.set(IAgentProfileService, {
    _serviceBrand: undefined,
    data: () => harness.executorContext.binding,
    preparePromptConfiguration: async () => false,
    getSystemPrompt: () => appendSharedPromptField(harness.executorContext.binding.systemPrompt, { values: { 'system.shared': 'ALL_EXECUTORS_SHARED' }, fields: [] }),
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
  ix.set(ISessionWorkspaceContext, harness.workspace);
  ix.provide(IAgentLoopService, {} as IAgentLoopService);
  ix.stub(IAgentPromptService, {});
  const execution = ix.get(IAgentExecutionService) as AgentExecutionService;
  return {
    ix,
    execution,
    starts: harness.starts,
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

  it('places a pinned argv model before the harness subcommand', () => {
    const context = {
      agent: {} as AgentExecutorContext['agent'],
      descriptor: {
        id: 'cursor-acp',
        protocol: 'acp-v1',
        command: 'cursor-agent',
        args: ['acp'],
        modelBinding: 'argv',
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
    expect(() => resolveAcpProcessArgs({
      ...context,
      binding: { ...context.binding, modelAlias: undefined },
    })).toThrow(/requires a pinned argv model/);
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
      origin: { kind: 'system_trigger', name: 'external-executor:example-acp' },
    })]);
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

  it('maps normalized events to live and canonical durable records with stable losses', async () => {
    const harness = createHarness({
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
      'tool_output_summary_only',
      'usage_context_only',
      'unknown_update_dropped',
      'unstable_acp_plan',
    ]));
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
      ...options,
      approval: async () => ({ decision: 'rejected', selectedOptionId: 'reject' }),
    });
    await expect(harness.session.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow();
    expect(harness.starts).toHaveLength(0);
  });

  it.each([
    ['auto', false],
    ['yolo', true],
  ] as const)('uses the declared %s permission mapping', async (permissionMode, value) => {
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

  it.each([
    ['manual', 'default'],
    ['auto', 'auto'],
    ['yolo', 'yolo'],
  ] as const)('configures Kimi ACP mode for %s before starting the turn', async (permissionMode, value) => {
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

  it.each(['sub', 'independent'] as const)('sends the refreshed cold %s identity through the ACP preamble', async (position) => {
    const harness = createExecutionHarness();
    const adapter = harness.ix.get(IAgentProfileService);
    const cold = await coldPromptFixture(position, adapter.data(), harness.ix.get(IAgentExecutorRegistry));
    vi.spyOn(adapter, 'data').mockImplementation(() => cold.profile.data());
    vi.spyOn(adapter, 'preparePromptConfiguration').mockImplementation(() => cold.profile.preparePromptConfiguration());
    vi.spyOn(adapter, 'getSystemPrompt').mockImplementation(() => cold.profile.getSystemPrompt());
    try {
      const run = await harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
      const sent = JSON.stringify(harness.starts[0]);
      expect(sent).toContain('Role NEW');
      expect(sent).not.toContain('Role OLD');
      expect(sent.split('SHARED_NEW')).toHaveLength(2);
      const snippet = cold.before.boundProfile?.promptBase?.delegationSnippet;
      expect(snippet).toBeTruthy();
      expect(sent.split(snippet!)).toHaveLength(2);
      expect(cold.profile.data().executorId).toBe(cold.before.executorId);
      await harness.execution.shutdown();
      await expect(run.completion).rejects.toBeDefined();
    } finally { harness.ix.dispose(); await harness.execution.shutdown(); await cold.dispose(); }
  });

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
        expect(JSON.stringify(harness.starts[0]).split('ALL_EXECUTORS_SHARED')).toHaveLength(2);
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
        expect(harness.interaction.cancelPendingForTurn).toHaveBeenCalledWith(run.turn.id);
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
