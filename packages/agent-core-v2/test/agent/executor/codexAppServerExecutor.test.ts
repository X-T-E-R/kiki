import {
  CodexClientError,
  CodexRemoteError,
  type CodexServerRequestHandler,
  type CodexTurnCompletion,
  type CodexTurnHandle,
  type NormalizedExecutorEvent,
} from '@kiki/codex-client';
import { describe, expect, it, vi } from 'vitest';
import { coldPromptFixture } from './coldPromptFixture';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
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
import { ISessionQuestionService } from '#/session/question/question';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';

interface HarnessOptions {
  readonly models?: readonly string[];
  readonly modelReasoningEfforts?: readonly string[];
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly priorThreadId?: string;
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
    [externalExecutorKey, options.priorThreadId === undefined ? {} : {
      executorId: 'codex-app-server',
      descriptorRevision: 'r1',
      sessionRef: {
        executorId: 'codex-app-server',
        version: 1,
        ref: { threadId: options.priorThreadId },
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
  const memory = {
    _serviceBrand: undefined,
    get: () => options.history ?? [],
    append: () => {},
    appendLoopEvent: () => {},
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
  const services = new Map<unknown, unknown>([
    [IAgentStateService, states],
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
  ]);
  const context: AgentExecutorContext = {
    agent: {
      id: 'codex-agent',
      accessor: { get: (id) => services.get(id) as never },
    },
    descriptor: {
      id: 'codex-app-server',
      protocol: 'codex-app-server',
      command: 'codex',
      args: [],
      revision: 'r1',
    },
    binding: {
      modelAlias: options.modelAlias ?? 'gpt-test',
      thinkingLevel: options.thinkingEffort ?? 'high',
      systemPrompt: 'Frozen profile instructions',
      executorId: 'codex-app-server',
      executorProtocol: 'codex-app-server',
      executorDescriptorRevision: 'r1',
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
    status: () => ({ state: 'ready' as const }),
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
      return { thread: { id: 'thread-new' } };
    },
    resumeThread: async (params: Readonly<Record<string, unknown>>) => {
      resumes.push(params);
      if (options.resumeError !== undefined) {
        throw options.resumeError instanceof Error
          ? options.resumeError
          : new Error('Configured resume failure');
      }
      return { thread: { id: String(params['threadId']) } };
    },
    startTurn: async (params: Readonly<Record<string, unknown>>): Promise<CodexTurnHandle> => {
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
  const createSession = (executorContext: AgentExecutorContext) => new CodexAppServerExecutorSession(
    executorContext,
    (_process, handler) => {
      serverHandler = handler;
      return client;
    },
  );
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
  ix.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
  ix.set(IAgentContextMemoryService, harness.memory);
  ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
  ix.set(IAgentExecutorRegistry, {
    resolveExecutable: async () => ({
      descriptor: harness.context.descriptor,
      options: {},
      provider: { create: harness.createSession },
    }),
  } as unknown as IAgentExecutorRegistry);
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
    starts: harness.starts,
    pendingTurns: harness.pendingTurns,
    interaction: harness.interaction,
    client: harness.client,
    runtimeLease: harness.runtimeLease,
    turnCancel: harness.turnCancel,
  };
}

describe('Codex app-server external executor', () => {
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
      profileDelivery: 'native',
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
        expect(harness.starts[0]?.['developerInstructions']).toBe('Frozen profile instructions\n\nALL_EXECUTORS_SHARED');
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
