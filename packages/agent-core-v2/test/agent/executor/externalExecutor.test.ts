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
} from '@moonshot-ai/acp-client';
import { describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { AcpAgentExecutorSession, buildHandoff } from '#/agent/execution/acpAgentExecutorSession';
import {
  ExecutorPlanUpdate,
  ExecutorRuntimeUpdate,
  ExecutorSessionUpdated,
  ExecutorTurnMetadata,
  externalExecutorKey,
} from '#/agent/execution/externalExecutorOps';
import { TurnPrompt, turnKey } from '#/agent/loop/turnOps';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import type { Event2 } from '#/app/event/event2';
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
  const starts: AcpTurnRequest[] = [];
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
    appendLoopEvent: (event: unknown) => loopEvents.push(event),
  } as unknown as IAgentContextMemoryService;
  const approval = {
    _serviceBrand: undefined,
    request: async () => {
      if (options.approval === undefined) throw new Error('no approval consumer');
      return options.approval();
    },
  } as unknown as ISessionApprovalService;
  const interaction = {
    _serviceBrand: undefined,
    cancelPendingForTurn: vi.fn(),
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
  const services = new Map<unknown, unknown>([
    [IAgentStateService, state.state],
    [IEventDispatcher, dispatcher],
    [IWireService, wire],
    [IAgentContextMemoryService, contextMemory],
    [ISessionApprovalService, approval],
    [ISessionInteractionService, interaction],
    [IAgentRuntimeService, runtime],
    [ISessionWorkspaceContext, workspace],
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
  const client = {
    status: () => ({ state: 'ready' as const, sessionId: 'remote-2' }),
    openSession: async (_input: AcpOpenSessionOptions) => openResult(),
    configureSession: async (input: {
      readonly configOptions?: readonly { configId: string; value: string | boolean }[];
    }) => {
      for (const selection of input.configOptions ?? []) {
        if (selection.configId === options.configureFailureId) {
          throw new Error('set_config_option failed');
        }
        selections.push(selection);
        configured = configured.map((option) =>
          option.id === selection.configId
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
        response: { stopReason: 'end_turn' },
        session: openResult(),
        stderrTail: '',
      };
      return {
        events: asyncEvents(options.events ?? []),
        completion: Promise.resolve(result),
        cancel: async () => true,
      };
    },
    cancel: async () => true,
    shutdown: async () => {},
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
      id: 'example-acp',
      protocol: 'acp-v1',
      command: 'example-acp',
      args: [],
      modelBinding: 'session_config',
      modelConfigCategory: 'model',
      thoughtConfigCategory: 'thought_level',
      revision: 'r1',
    },
    binding: {
      modelAlias: 'model-a',
      thinkingLevel: 'high',
      systemPrompt: 'Frozen profile',
      executorId: 'example-acp',
      executorProtocol: 'acp-v1',
      executorDescriptorRevision: 'r1',
    },
  };
  const session = new AcpAgentExecutorSession(
    executorContext,
    (_process, handler) => {
      permissionHandler = handler;
      return client;
    },
  );
  return {
    session,
    events,
    loopEvents,
    starts,
    selections,
    permissionDecisions,
    interaction,
    wire,
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

  it('marks permission mode unverified without an approval config surface', async () => {
    const harness = createHarness({
      permissionSurface: false,
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
    expect(metadata?.losses).toContain('permission_mode_unverified');
  });
});
