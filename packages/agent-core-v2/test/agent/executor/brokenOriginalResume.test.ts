import { PassThrough, Readable, Writable } from 'node:stream';

import { AcpProcessClient, type AcpOpenSessionOptions, type HostProcessLike } from '@kiki/acp-client';
import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { agentExecutorBindingFingerprint, IAgentExecutorRegistry, type AgentExecutorProvider } from '#/app/agentExecutor/agentExecutor';
import type { NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { IConfigService } from '#/app/config/config';
import { IRequestGovernance } from '#/app/requestGovernance/requestGovernance';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { createHooks } from '#/hooks';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { contextRevisionKey } from '#/agent/contextMemory/contextOps';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { AgentModelSwitch, modelSwitchCompletionsKey } from '#/agent/modelSwitch/modelSwitchOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { ISubagentTool } from '#/agent/tools/agent/agent';
import { SubagentTool } from '#/agent/tools/agent/agentTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCollaborationRegistry, COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { externalExecutorKey } from '#/agent/execution/externalExecutorOps';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { stubLog } from '../../_base/log/stubs';
import { createTestAgent } from '../../harness';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { connectInProcessScriptedAgent, createInProcessScriptedAgent, type InProcessAgentScript } from '../../../../acp-client/test/fixtures/in-process-scripted-agent';

import { createExecutionHarness } from './externalExecutor.test';

const CHILD = 'external-agent';
const BODY = 'saved body for the original remote session';
const signal = new AbortController().signal;

function scriptedChild(): { child: HostProcessLike; toAgent: PassThrough; fromAgent: PassThrough } {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => { resolveExit = resolve; });
  const child: HostProcessLike = {
    pid: 42,
    get exitCode() { return exitCode; },
    stdin: toAgent,
    stdout: fromAgent,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose: () => {},
  };
  return { child, toAgent, fromAgent };
}

function recordingClient(script: () => InProcessAgentScript, failSpawn: () => boolean, id = 'example-acp', sourceId?: string) {
  const opens: AcpOpenSessionOptions[] = [];
  const histories: Array<ReturnType<typeof createInProcessScriptedAgent>['history']> = [];
  let spawns = 0;
  let currentChild: HostProcessLike | undefined;
  let nextTurnError: Error | undefined;
  const createClient = () => {
    const instance = new AcpProcessClient({
      spawn: async () => {
        spawns += 1;
        if (failSpawn()) throw new Error('spawn failed');
        const { child, toAgent, fromAgent } = scriptedChild();
        currentChild = child;
        const fixture = createInProcessScriptedAgent(script());
        histories.push(fixture.history);
        connectInProcessScriptedAgent(fixture.app, Writable.toWeb(fromAgent), Readable.toWeb(toAgent));
        return child;
      },
    }, { id, sourceId, command: id, startupTimeoutMs: 5_000 }, { platform: 'linux' });
    const openSession = instance.openSession.bind(instance);
    instance.openSession = (async (options: AcpOpenSessionOptions) => {
      opens.push(options);
      return openSession(options);
    }) as typeof instance.openSession;
    const startTurn = instance.startTurn.bind(instance);
    instance.startTurn = (async (request) => {
      const handle = await startTurn(request);
      const pendingError = nextTurnError;
      if (pendingError === undefined) return handle;
      nextTurnError = undefined;
      return {
        ...handle,
        completion: handle.completion.then(async () => {
          await currentChild?.kill();
          throw pendingError;
        }),
      };
    }) as typeof instance.startTurn;
    return instance;
  };
  const client = createClient();
  return {
    client,
    createClient,
    failNextTurn: (error: Error) => { nextTurnError = error; },
    opens,
    histories,
    spawns: () => spawns,
    exit: async () => { await currentChild?.kill(); },
  };
}

function sessionMetadata(): ISessionMetadata & { agents: Record<string, AgentMeta> } {
  const agents: Record<string, AgentMeta> = {
    main: { type: 'main' },
    [CHILD]: {
      type: 'sub',
      delegator: { kind: 'agent', agentId: 'main' },
      executor: 'example-acp',
      labels: { [COLLABORATION_TASK_NAME_LABEL]: 'researcher' },
    },
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    agents,
    read: async () => ({ id: 'session-1', createdAt: 1, updatedAt: 1, archived: false, agents, custom: {} }),
    updateAgent: async (agentId: string, update: (current: AgentMeta) => AgentMeta) => {
      const current = agents[agentId];
      if (current !== undefined) agents[agentId] = update(current);
    },
    getAgentExecutor: async () => undefined,
    registerAgent: async () => {},
    createdByLoad: () => true,
    onDidChangeMetadata: () => ({ dispose() {} }),
  } as unknown as ISessionMetadata & { agents: Record<string, AgentMeta> };
}

function modelSwitchFor(executionIx: TestInstantiationService, metadata: ISessionMetadata) {
  const state = executionIx.get(IAgentStateService);
  state.contributeState(contextRevisionKey);
  state.contributeState(contextWindowEpochKey);
  const ix = new TestInstantiationService();
  ix.set(ILogService, stubLog());
  ix.set(IAgentStateService, state);
  ix.set(IEventDispatcher, {
    dispatch: async (event: { operationId?: string; agentId?: string; fromModel?: string; toModel?: string; mode?: 'direct'; thinking?: string; newEpoch?: number; summaryGenerated?: boolean; input?: unknown }) => {
      if (!(event instanceof AgentModelSwitch)) return;
      const current = state.get(modelSwitchCompletionsKey) as Map<string, { input: AgentModelSwitch['input']; receipt: { operationId: string; agentId: string; state: 'completed'; fromModel: string; toModel: string; mode: AgentModelSwitch['mode']; binding: { model: string; thinking: string }; windowEpoch: number; summaryGenerated: boolean } }>;
      current.set(event.operationId, {
        input: event.input,
        receipt: {
          operationId: event.operationId,
          agentId: event.agentId,
          state: 'completed',
          fromModel: event.fromModel,
          toModel: event.toModel,
          mode: event.mode,
          binding: { model: event.toModel, thinking: event.thinking },
          windowEpoch: event.newEpoch,
          summaryGenerated: event.summaryGenerated,
        },
      });
    },
    flush: async () => {},
  } as never);
  ix.set(IAgentScopeContext, executionIx.get(IAgentScopeContext));
  ix.set(IAgentLoopService, {
    tryAcquireQuiescence: () => ({ dispose() {} }),
    status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as never);
  ix.set(IAgentProfileService, executionIx.get(IAgentProfileService));
  const memory = executionIx.get(IAgentContextMemoryService);
  const history = memory.get();
  ix.set(IAgentContextMemoryService, { ...memory, get: () => history });
  ix.set(IAgentFullCompactionService, { isCompacting: () => false } as never);
  ix.set(IAgentTokenCountingService, { get: () => ({ size: 0 }) } as never);
  ix.set(IAgentLLMRequesterService, { invalidatePromptSnapshots: () => {} } as never);
  ix.set(IAgentToolRegistryService, {} as never);
  ix.set(IAgentToolSelectService, {} as never);
  ix.set(IAgentTaskService, { list: () => [] } as never);
  ix.set(IAgentMemorySnapshot, {} as never);
  ix.set(ISessionContext, { sessionId: 'session-1' } as never);
  ix.set(ISessionMetadata, metadata);
  ix.set(IAgentModelSwitchService, new SyncDescriptor(AgentModelSwitchService));
  return { service: ix.get(IAgentModelSwitchService), dispose: () => ix.dispose() };
}

function queuedStore(agentId: string) {
  let message: AgentMessageAcceptance['message'] | undefined;
  let delivered = false;
  const claim = {} as import('#/app/threadCommunication/threadMailboxStore').ThreadDeliveryClaim;
  const store: IAgentCollaborationMessageStore = {
    _serviceBrand: undefined,
    accept: async (input) => {
      message ??= {
        messageId: 'msg-original',
        sessionId: input.sessionId,
        sourceAgentId: input.sourceAgentId,
        sourceTaskName: input.sourceTaskName,
        targetAgentId: input.targetAgentId,
        targetTaskName: input.targetTaskName,
        content: input.content,
        acceptedAt: 1,
        targetSeq: 1,
      };
      return { message, deduplicated: message.content !== input.content, delivery: delivered ? 'delivered' as const : 'queued' as const, payloadConflict: message.content !== input.content };
    },
    nextQueued: async () => delivered || message === undefined ? undefined : { message, claim },
    markDelivered: async () => { delivered = true; return true; },
    listPendingAgents: async () => delivered || message === undefined ? [] : [agentId],
    discardPending: async () => ({ discarded: 0 }),
  };
  return { store, delivered: () => delivered, message: () => message };
}

function admitBrokenResume(ix: TestInstantiationService): void {
  ix.stub(IRequestGovernance, { acquireAgent: async () => ({ release() {} }) });
  ix.stub(ISessionContext, { sessionId: 'session-1' });
  ix.stub(IAgentActivityView, { state: () => ({ lifecycle: 'ready', background: [] }) });
  const caps = new Map<string, NegotiatedExecutorCapabilities>();
  const registry = ix.get(IAgentExecutorRegistry);
  registry.recordNegotiated = (id, version, capabilities) => {
    const key = `${id}\0${version ?? ''}`;
    caps.set(key, { ...caps.get(key), ...capabilities });
  };
  registry.negotiated = (id, version) => caps.get(`${id}\0${version ?? ''}`);
}

const argvPermission = {
  via: 'argv' as const,
  flag: '--permission-mode',
  manual: 'default',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
};

describe('recoverable ACP broken resume', () => {
  it.each([true, false])('preserves the opened identity when the process exits before prompt (resume=%s)', async supported => {
    const remote = recordingClient(() => ({ sessionId: `remote-${remote.spawns()}`,
      capabilities: supported ? { loadSession: true, sessionCapabilities: { resume: {} } } : {},
    }), () => false);
    const harness = createExecutionHarness({ client: remote.client, modelBinding: 'argv', thinkingEffort: 'medium', permissionMapping: null });
    const startTurn = remote.client.startTurn.bind(remote.client);
    vi.spyOn(remote.client, 'startTurn').mockImplementationOnce(async request => {
      expect(harness.ix.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref['sessionId']).toBe('remote-1');
      await remote.exit();
      return startTurn(request);
    });
    try {
      const run = harness.execution.run({ kind: 'prompt', prompt: 'work' }, { signal });
      if (supported) await (await run).completion;
      else await expect(run).rejects.toMatchObject({ code: 'executor.session_open_failed' });
      expect(remote.histories[0]?.methods.filter(method => method === 'session/new')).toHaveLength(1);
      expect(remote.histories.slice(1).flatMap(history => history.methods)).not.toContain('session/new');
      const prompts = remote.histories.flatMap(history => history.promptParams);
      expect(prompts).toHaveLength(supported ? 1 : 0);
      if (supported) expect(prompts[0]).toMatchObject({ sessionId: 'remote-1' });
      expect(remote.opens.slice(1).every(options => options.requireResume === true && options.sessionRef?.ref['sessionId'] === 'remote-1')).toBe(true);
      expect(harness.ix.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref['sessionId']).toBe('remote-1');
    } finally { await harness.execution.dispose(); await harness.ix.dispose(); }
  });

  it.each(['retained', 'reset', 'reject', 'readback', 'disconnect'] as const)('restores and verifies actual reopened controls before prompt: %s', async scenario => {
    const processes: Array<{ disconnect(): void }> = [];
    const methods: Array<{ generation: number; method: string }> = [];
    let controls = { model: 'ambient-model', thought: 'low', autoApprove: true };
    const prompts: Array<typeof controls & { sessionId: string }> = [];
    const configOptions = () => [
      { id: 'model-id', name: 'Model', category: 'model', type: 'select', currentValue: controls.model,
        options: [{ value: 'model-a', name: 'A' }, { value: 'ambient-model', name: 'Ambient' }] },
      { id: 'thought-id', name: 'Thought', category: 'thought_level', type: 'select', currentValue: controls.thought,
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      { id: 'auto_approve', name: 'Auto approve', category: 'mode', type: 'boolean', currentValue: controls.autoApprove },
    ];
    const client = new AcpProcessClient({ spawn: async () => {
      const generation = processes.length + 1;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let exitCode: number | null = null;
      let finish!: (code: number) => void;
      const exited = new Promise<number>(resolve => { finish = resolve; });
      const disconnect = () => { if (exitCode !== null) return; exitCode = 0; stdout.end(); stderr.end(); finish(0); };
      let input = '';
      const stdin = new Writable({ write(chunk, _encoding, callback) {
        input += String(chunk);
        for (let newline = input.indexOf('\n'); newline >= 0; newline = input.indexOf('\n')) {
          const line = input.slice(0, newline); input = input.slice(newline + 1);
          const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
          methods.push({ generation, method: request.method });
          if (request.id === undefined) continue;
          const reply = (result: unknown) => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
          if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
          else if (request.method === 'session/new') reply({ sessionId: 'remote-original', configOptions: configOptions() });
          else if (request.method === 'session/resume' || request.method === 'session/load') {
            if (scenario !== 'retained') controls = { model: 'ambient-model', thought: 'low', autoApprove: true };
            reply({ configOptions: configOptions() });
          } else if (request.method === 'session/set_config_option') {
            if (generation > 1 && scenario === 'reject') {
              stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'fixture selection refused' } }) + '\n');
              continue;
            }
            if (generation > 1 && scenario === 'disconnect') { disconnect(); continue; }
            if (generation === 1 || scenario !== 'readback') {
              if (request.params?.['configId'] === 'model-id') controls.model = String(request.params['value']);
              if (request.params?.['configId'] === 'thought-id') controls.thought = String(request.params['value']);
              if (request.params?.['configId'] === 'auto_approve') controls.autoApprove = request.params['value'] === true;
            }
            reply({ configOptions: configOptions() });
          } else if (request.method === 'session/prompt') {
            prompts.push({ sessionId: String(request.params?.['sessionId']), ...controls });
            reply({ stopReason: 'end_turn' });
          } else reply({});
        }
        callback();
      } });
      processes.push({ disconnect });
      return { pid: generation, get exitCode() { return exitCode; }, stdin, stdout, stderr,
        wait: () => exited, kill: async () => disconnect(), dispose() {} };
    } }, { id: 'example-acp', command: 'fixture', startupTimeoutMs: 2_000, shutdownGraceMs: 20 }, { platform: 'linux' });
    const harness = createExecutionHarness({ client, permissionMode: 'manual' });
    const startTurn = client.startTurn.bind(client);
    vi.spyOn(client, 'startTurn').mockImplementationOnce(async request => {
      expect(controls).toEqual({ model: 'model-a', thought: 'high', autoApprove: false });
      processes[0]!.disconnect();
      await vi.waitFor(() => expect(client.status().state).toBe('cold'));
      return startTurn(request);
    });
    try {
      const run = harness.execution.run({ kind: 'prompt', prompt: 'perform work' }, { signal });
      if (scenario === 'retained' || scenario === 'reset') {
        await (await run).completion;
        expect(prompts).toEqual([{ sessionId: 'remote-original', model: 'model-a', thought: 'high', autoApprove: false }]);
      } else {
        await expect(run).rejects.toThrow();
        expect(prompts).toEqual([]);
      }
      expect(methods.filter(entry => entry.method === 'session/new')).toHaveLength(1);
      expect(methods.filter(entry => entry.generation > 1 && entry.method === 'session/resume')).toHaveLength(1);
      expect(harness.ix.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref['sessionId']).toBe('remote-original');
    } finally { await harness.execution.dispose(); await harness.ix.dispose(); }
  });

  it('resumes the original remote session through AgentRun after a real open fails', async () => {
    let failSpawn = true;
    const remote = recordingClient(() => ({
      sessionId: 'remote-original',
      capabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    }), () => failSpawn);
    const harness = createExecutionHarness({
      agentId: CHILD,
      client: remote.client,
      modelBinding: 'argv',
      thinkingEffort: 'medium',
      permission: argvPermission,
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionEpoch: 1,
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-original' } },
        profileDeliveredSessionId: 'remote-original',
        profileDelivery: 'first_prompt_preamble',
      },
    });
    admitBrokenResume(harness.ix);
    const metadata = sessionMetadata();
    const switched = modelSwitchFor(harness.ix, metadata);
    const senderCtx = createTestAgent();
    const mailbox = queuedStore(CHILD);
    const loop = {
      _serviceBrand: undefined,
      enqueue: () => { throw new Error('unexpected enqueue'); },
      status: () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false }),
      settled: () => Promise.resolve(),
      tryAcquireQuiescence: () => undefined,
      hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    } as unknown as IAgentLoopService;
    const handle: IAgentScopeHandle = {
      id: CHILD,
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentExecutionService) return harness.execution as T;
          if (id === IAgentModelSwitchService) return switched.service as T;
          if (id === IAgentLoopService) return loop as T;
          if (id === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) } as T;
          if (id === IAgentToolPolicyService) return { isToolActive: () => false } as T;
          if (id === ISessionMetadata) return metadata as T;
          return harness.ix.get(id);
        },
      },
      dispose: () => {},
    };
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => senderCtx.get(id) },
      dispose: () => {},
    };
    const lifecycle = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      get: (id: string) => id === CHILD ? handle : id === 'main' ? main : undefined,
      list: () => [main, handle],
      create: async () => { throw new Error('unexpected create'); },
    } as unknown as IAgentLifecycleService;
    const session = {
      _serviceBrand: undefined,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      sessionDir: 'session-dir',
      metaScope: 'session/scope',
      cwd: 'cwd',
      scope: (subKey?: string) => subKey === undefined ? 'session/scope' : `session/scope/${subKey}`,
    } as ISessionContext;
    const messagingIx = new TestInstantiationService();
    messagingIx.set(IFileSystemStorageService, new InMemoryStorageService());
    messagingIx.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    messagingIx.set(IAgentCollaborationMessageStore, mailbox.store);
    messagingIx.set(IAgentLifecycleService, lifecycle);
    messagingIx.set(ISessionContext, session);
    messagingIx.set(ISessionMetadata, metadata);
    messagingIx.stub(ISessionDispatchService, { runOnExisting: async () => { throw new Error('AgentSend must not dispatch while broken'); } });
    messagingIx.stub(ISessionManager, {});
    messagingIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    messagingIx.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
    const messaging = messagingIx.get(IAgentCollaborationMessagingService) as AgentCollaborationMessagingService;
    const toolIx = new TestInstantiationService();
    toolIx.stub(IAgentLifecycleService, lifecycle);
    toolIx.stub(ISessionMetadata, metadata);
    toolIx.stub(ISessionSubagentService, {
      hooks: createHooks(['onWillStartAgentTask']),
      retain: () => ({ dispose: () => {} }),
      notifyAgentTaskStopped: () => {},
      run: async (_agentId: string, request: import('#/session/subagent/subagent').AgentRunRequest, options: { signal: AbortSignal }) =>
        harness.execution.run(request, options),
    });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    toolIx.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main', scope: (key?: string) => `agent/main/${key ?? ''}` });
    toolIx.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    toolIx.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    toolIx.stub(IAgentToolPolicyService, {
      isToolActive: () => true,
      isToolActiveForDisclosure: () => true,
      isToolActiveForProfile: () => true,
      setSessionDisabledTools: async () => {},
    });
    toolIx.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    toolIx.stub(IAgentRuntimeService, senderCtx.get(IAgentRuntimeService));
    toolIx.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    toolIx.set(ISubagentTool, new SyncDescriptor(SubagentTool));
    const fingerprint = () => (harness.ix.get(IAgentStateService).get(externalExecutorKey) as { bindingFingerprint?: string; sessionRef?: { ref: { sessionId?: string } } }).bindingFingerprint;
    try {
      await expect(harness.execution.run({ kind: 'prompt', prompt: 'first open' }, { signal })).rejects.toThrow(/Failed to spawn ACP agent|SessionOpenFailed|spawn failed/i);
      expect(remote.client.status().state).toBe('broken');
      expect(harness.execution.status()).toEqual({ state: 'broken' });
      expect(harness.execution.canResumeBrokenOriginal()).toBe(true);
      expect(remote.spawns()).toBe(2);
      expect(remote.histories).toHaveLength(0);
      const savedFingerprint = fingerprint();
      expect(savedFingerprint).toHaveLength(64);

      await expect(messaging.send({
        sourceAgentId: 'main',
        sourceTaskName: 'root',
        targetAgentId: CHILD,
        targetTaskName: 'researcher',
        content: BODY,
        idempotencyKey: 'saved-body',
        waitForRunningDelivery: true,
        idleWake: 'owned-child',
      })).rejects.toThrow(/Resume the original remote session with AgentRun/);
      expect(mailbox.delivered()).toBe(false);
      expect((await mailbox.store.nextQueued('session-1', CHILD))?.message.content).toBe(BODY);

      failSpawn = false;
      let sawBrokenAtSwitch = false;
      const execute = switched.service.execute.bind(switched.service);
      switched.service.execute = (async (input, options) => {
        sawBrokenAtSwitch = harness.execution.status().state === 'broken';
        return execute(input, options);
      }) as typeof switched.service.execute;
      const result = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 2,
        toolCallId: 'toolu_resume_broken',
        args: { resume: CHILD, prompt: '', description: 'resume saved message', background: true },
        signal,
      });
      await harness.execution.settled();

      expect(result.isError, JSON.stringify(result.output)).toBeFalsy();
      expect(sawBrokenAtSwitch).toBe(true);
      expect(harness.execution.canResumeBrokenOriginal()).toBe(false);
      expect(remote.spawns()).toBe(3);
      expect(remote.opens[0]).toMatchObject({ requireResume: true, sessionRef: { ref: { sessionId: 'remote-original' } } });
      expect(remote.opens[1]).toMatchObject({ requireResume: true, sessionRef: { ref: { sessionId: 'remote-original' } } });
      expect(remote.histories).toHaveLength(1);
      expect(remote.histories[0]?.methods).toContain('session/resume');
      expect(remote.histories[0]?.methods).not.toContain('session/new');
      expect(remote.histories[0]?.sessionResumeParams).toEqual([
        expect.objectContaining({ sessionId: 'remote-original' }),
      ]);
      expect(remote.histories[0]?.sessionNewParams).toHaveLength(0);
      const prompted = JSON.stringify(remote.histories[0]?.promptParams);
      expect(prompted.split(BODY).length - 1).toBe(1);
      expect(mailbox.delivered()).toBe(true);
      expect(await mailbox.store.nextQueued('session-1', CHILD)).toBeUndefined();
      expect(fingerprint()).toBe(savedFingerprint);
      expect((harness.ix.get(IAgentStateService).get(externalExecutorKey) as { sessionRef?: { ref: { sessionId?: string } } }).sessionRef?.ref.sessionId).toBe('remote-original');
      expect(JSON.stringify(result.output)).not.toContain(BODY);
    } finally {
      await messaging.dispose();
      await messagingIx.dispose();
      await toolIx.dispose();
      await switched.dispose();
      await harness.execution.shutdown();
      await remote.client.shutdown();
      await harness.ix.dispose();
      await senderCtx.dispose();
    }
  });

  it('refuses a broken ACP child whose original session cannot be resumed and does not open a new one', async () => {
    const remote = recordingClient(() => ({ capabilities: {} }), () => false);
    const harness = createExecutionHarness({
      agentId: CHILD,
      client: remote.client,
      modelBinding: 'argv',
      permission: argvPermission,
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionEpoch: 1,
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-original' } },
      },
    });
    admitBrokenResume(harness.ix);
    const metadata = sessionMetadata();
    const senderCtx = createTestAgent();
    const handle: IAgentScopeHandle = {
      id: CHILD,
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentExecutionService) return harness.execution as T;
          if (id === IAgentProfileService) return harness.ix.get(IAgentProfileService) as T;
          if (id === IAgentLoopService) return { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) } as T;
          return harness.ix.get(id);
        },
      },
      dispose: () => {},
    };
    const toolIx = new TestInstantiationService();
    toolIx.stub(IAgentLifecycleService, {
      get: (id: string) => id === CHILD ? handle : id === 'main' ? {
        id: 'main', kind: LifecycleScope.Agent, accessor: { get: <T>(service: ServiceIdentifier<T>): T => senderCtx.get(service) }, dispose: () => {},
      } : undefined,
      list: () => [handle],
    });
    toolIx.stub(ISessionMetadata, metadata);
    toolIx.stub(ISessionSubagentService, { hooks: createHooks(['onWillStartAgentTask']), retain: () => ({ dispose: () => {} }), notifyAgentTaskStopped: () => {}, run: async () => { throw new Error('unrecoverable broken must not start'); } });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    toolIx.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main', scope: () => 'agent/main' });
    toolIx.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    toolIx.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    toolIx.stub(IAgentToolPolicyService, { isToolActive: () => true, isToolActiveForDisclosure: () => true, isToolActiveForProfile: () => true, setSessionDisabledTools: async () => {} });
    toolIx.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    toolIx.stub(IAgentRuntimeService, senderCtx.get(IAgentRuntimeService));
    toolIx.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    toolIx.set(ISubagentTool, new SyncDescriptor(SubagentTool));
    try {
      await expect(harness.execution.run({ kind: 'prompt', prompt: 'cannot resume' }, { signal })).rejects.toThrow();
      expect(remote.client.status().state).toBe('broken');
      expect(harness.execution.status()).toEqual({ state: 'broken' });
      expect(harness.execution.canResumeBrokenOriginal()).toBe(false);
      const spawned = remote.spawns();
      expect(remote.histories.every((history) => history.sessionNewParams.length === 0)).toBe(true);
      const result = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 3,
        toolCallId: 'toolu_refuse_broken',
        args: { resume: CHILD, prompt: '', description: 'resume saved message', background: true },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.output)).toContain('original remote session cannot be resumed');
      expect(JSON.stringify(result.output)).not.toContain('already running');
      expect(remote.spawns()).toBe(spawned);
      expect(remote.histories.every((history) => history.sessionNewParams.length === 0)).toBe(true);
    } finally {
      await toolIx.dispose();
      await harness.execution.shutdown();
      await remote.client.shutdown();
      await harness.ix.dispose();
      await senderCtx.dispose();
    }
  });

  it('tells the sender when the first AgentSend resume is unsupported and does not promise AgentRun', async () => {
    const remote = recordingClient(() => ({ capabilities: {} }), () => false);
    const harness = createExecutionHarness({
      agentId: CHILD,
      client: remote.client,
      modelBinding: 'argv',
      permission: argvPermission,
      prior: {
        executorId: 'example-acp',
        descriptorRevision: 'r1',
        sessionEpoch: 1,
        sessionRef: { executorId: 'example-acp', version: 1, ref: { sessionId: 'remote-original' } },
      },
    });
    admitBrokenResume(harness.ix);
    const metadata = sessionMetadata();
    const mailbox = queuedStore(CHILD);
    const notices: string[] = [];
    const childLoop = {
      enqueue: () => { throw new Error('child must not enqueue'); },
      status: () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false }),
      settled: () => Promise.resolve(),
      hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    } as unknown as IAgentLoopService;
    const handle: IAgentScopeHandle = {
      id: CHILD,
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentExecutionService) return harness.execution as T;
          if (id === IAgentLoopService) return childLoop as T;
          if (id === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) } as T;
          return harness.ix.get(id);
        },
      },
      dispose: () => {},
    };
    const mainLoop = {
      enqueue: (request: { resolveContextMessages(): readonly { content: readonly { type: string; text?: string }[] }[] }) => {
        for (const message of request.resolveContextMessages()) {
          notices.push(message.content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join(''));
        }
      },
      status: () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false }),
      settled: () => Promise.resolve(),
      hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    } as unknown as IAgentLoopService;
    const mainExecution = {
      status: () => ({ state: 'idle' as const }),
      canResumeBrokenOriginal: () => false,
      hooks: createHooks(['onWillRun']),
      settled: async () => {},
    } as unknown as IAgentExecutionService;
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentLoopService) return mainLoop as T;
          if (id === IAgentExecutionService) return mainExecution as T;
          if (id === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) } as T;
          return harness.ix.get(id);
        },
      },
      dispose: () => {},
    };
    const lifecycle = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      get: (id: string) => id === CHILD ? handle : id === 'main' ? main : undefined,
      list: () => [main, handle],
      create: async () => { throw new Error('unexpected create'); },
    } as unknown as IAgentLifecycleService;
    const session = {
      _serviceBrand: undefined,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      sessionDir: 'session-dir',
      metaScope: 'session/scope',
      cwd: 'cwd',
      scope: (subKey?: string) => subKey === undefined ? 'session/scope' : `session/scope/${subKey}`,
    } as ISessionContext;
    const messagingIx = new TestInstantiationService();
    messagingIx.set(IFileSystemStorageService, new InMemoryStorageService());
    messagingIx.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    messagingIx.set(IAgentCollaborationMessageStore, mailbox.store);
    messagingIx.set(IAgentLifecycleService, lifecycle);
    messagingIx.set(ISessionContext, session);
    messagingIx.set(ISessionMetadata, metadata);
    messagingIx.set(ISessionDispatchService, {
      runOnExisting: async (...[child, request, options]: Parameters<ISessionDispatchService['runOnExisting']>) => {
        const runRequest = typeof request === 'string' ? { kind: 'prompt' as const, prompt: request } : request;
        return {
          child,
          request: runRequest,
          started: harness.execution.run(runRequest, { signal: options.signal }),
        };
      },
      recordDelegatedRun: () => {},
    } as unknown as ISessionDispatchService);
    messagingIx.set(ISessionManager, {
      acquire: async () => ({
        handle: {
          id: 'session-1',
          kind: LifecycleScope.Session,
          accessor: {
            get: <T>(id: ServiceIdentifier<T>): T => {
              if (id === IAgentLifecycleService) return lifecycle as T;
              throw new Error('unexpected session service');
            },
          },
          dispose: () => {},
        },
        dispose: () => {},
      }),
    } as unknown as ISessionManager);
    messagingIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    messagingIx.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
    const messaging = messagingIx.get(IAgentCollaborationMessagingService) as AgentCollaborationMessagingService;
    const saved = 'saved body that stays queued after an unsupported resume';
    try {
      expect(harness.execution.status()).toEqual({ state: 'idle' });
      const accepted = await messaging.send({
        sourceAgentId: 'main',
        sourceTaskName: 'root',
        targetAgentId: CHILD,
        targetTaskName: 'researcher',
        content: saved,
        idempotencyKey: 'first-unsupported-resume',
        waitForRunningDelivery: false,
        idleWake: 'owned-child',
      });
      expect(accepted.delivery).toBe('queued');
      expect(accepted.resumed).toBeUndefined();
      await vi.waitFor(() => { expect(notices.length).toBeGreaterThan(0); });
      const notice = notices.at(-1) ?? '';
      expect(harness.execution.status()).toEqual({ state: 'broken' });
      expect(harness.execution.canResumeBrokenOriginal()).toBe(false);
      expect(harness.ix.get(IAgentExecutorRegistry).negotiated?.('example-acp', undefined)).toMatchObject({
        resume: false,
        load: false,
      });
      expect(notice).toContain(accepted.message.messageId);
      expect(notice).toContain('executor.session_open_failed');
      expect(notice).toContain('The requested external session cannot be resumed or loaded');
      expect(notice).toContain(`Message ${accepted.message.messageId} stays queued`);
      expect(notice).toContain('Do not call AgentSend again');
      expect(notice).toContain('Do not open a new remote session');
      expect(notice).not.toContain('AgentRun');
      expect(notice).not.toContain('Set resume to');
      expect(notice).not.toContain('empty string');
      expect(notice).not.toContain('new_window');
      expect(notice).not.toContain(`Agent instance "${CHILD}" is broken`);
      expect(remote.opens[0]).toMatchObject({
        requireResume: true,
        sessionRef: { ref: { sessionId: 'remote-original' } },
      });
      expect(remote.histories.every((history) => history.sessionNewParams.length === 0)).toBe(true);
      expect(mailbox.delivered()).toBe(false);
      expect((await mailbox.store.nextQueued('session-1', CHILD))?.message.content).toBe(saved);
    } finally {
      await messaging.dispose();
      await messagingIx.dispose();
      await harness.execution.shutdown();
      await remote.client.shutdown();
      await harness.ix.dispose();
    }
  });

  it.each(['account-switch', 'legacy-network', 'legacy-settled-tool-error', 'legacy-load-failure', 'legacy-unsettled'] as const)('uses real profile/dispatch for original-session recovery: %s', async (scenario) => {
    const legacy = scenario !== 'account-switch';
    const legacySessionId = '11111111-1111-4111-8111-111111111111';
    const nativeId = '22222222-2222-4222-8222-222222222222';
    const networkError = scenario === 'legacy-settled-tool-error'
      ? 'AGY terminal status ERROR: The stream was interrupted. Please continue the task you were working on.'
      : 'AGY terminal status ERROR: There was a network issue connecting to the server, please try again.';
    const familyDesc = {
      id: 'agy-cli',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      revision: 'r-family',
    };
    const instanceADesc = {
      id: 'instance-agy-a',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-a',
      instance: {
        id: 'instance-agy-a',
        source_executor: 'agy-cli',
        label: 'Account A',
        configuration: { kind: 'plugin_account' as const, source_id: 'plugin:magpie/agy', account_id: 'acct-a' },
        proxy: { kind: 'inherit' as const },
      },
    };
    const instanceBDesc = {
      id: 'instance-agy-b',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-b',
      instance: {
        id: 'instance-agy-b',
        source_executor: 'agy-cli',
        label: 'Account B',
        configuration: { kind: 'plugin_account' as const, source_id: 'plugin:magpie/agy', account_id: 'acct-b' },
        proxy: { kind: 'inherit' as const },
      },
    };
    let oldBridge = legacy;
    const toolCallId = `agy-${nativeId}-2`;
    const toolName = scenario === 'legacy-settled-tool-error' ? 'edit_file' : 'read_file';
    const remoteA = recordingClient(() => ({
      sessionId: legacy ? legacySessionId : 'remote-shared-1',
      capabilities: { loadSession: !oldBridge },
      load: scenario === 'legacy-load-failure' ? 'unknown_session' : undefined,
      promptError: oldBridge ? networkError : undefined,
      promptUpdates: oldBridge ? [
        { sessionUpdate: 'tool_call', toolCallId, title: toolName, kind: 'other', status: 'in_progress' },
        ...scenario === 'legacy-unsettled' ? [] : [{
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: scenario === 'legacy-settled-tool-error' ? 'failed' : 'completed',
          rawOutput: scenario === 'legacy-settled-tool-error' ? 'file does not exist' : 'old tool output',
        }],
      ] : undefined,
    }), () => false, 'instance-agy-a', 'agy-cli');
    const remoteB = recordingClient(() => ({
      sessionId: 'remote-shared-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-agy-b', 'agy-cli');
    const descriptors = new Map([
      [familyDesc.id, familyDesc],
      [instanceADesc.id, instanceADesc],
      [instanceBDesc.id, instanceBDesc],
    ]);
    const { AcpAgentExecutorSession } = await import('#/agent/execution/acpAgentExecutorSession');
    const { AGENT_EXECUTOR_INSTANCES_SECTION } = await import('#/app/agentExecutor/executorInstances');
    const { AGENT_EXECUTOR_OVERRIDES_SECTION } = await import('#/app/agentExecutor/executorOverrides');
    const { normalizeAgentProfile } = await import('#/app/agentProfileCatalog/agentProfileCatalog');
    const { makeAgentScopeContext } = await import('#/agent/scopeContext/scopeContext');
    const { AgentExecutionService } = await import('#/agent/execution/executionService');
    const { agentService, appService, sessionService } = await import('../../harness');
    const caps = new Map<string, NegotiatedExecutorCapabilities>();
    let createdSession: import('#/agent/execution/acpAgentExecutorSession').AcpAgentExecutorSession | undefined;
    const provider: AgentExecutorProvider = {
      id: 'example-acp',
      protocol: 'acp-v1',
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: (ctx) => {
        createdSession = new AcpAgentExecutorSession(ctx, () =>
          (ctx.descriptor.id === 'instance-agy-b' ? remoteB : remoteA).createClient());
        return createdSession;
      },
    };
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      list: () => [...descriptors.values()],
      get: (id: string) => descriptors.get(id),
      resolve: (id: string) => ({ descriptor: descriptors.get(id)!, options: {}, provider }),
      validateBinding: (_id, _opts, binding) => ({ ok: true, binding }),
      discover: async () => [],
      provider: (protocol) => protocol === provider.protocol ? provider : undefined,
      recordNegotiated: (id, version, capabilities) => {
        const key = `${id}\0${version ?? ''}`;
        caps.set(key, { ...caps.get(key), ...capabilities });
      },
      negotiated: (id, version) => caps.get(`${id}\0${version ?? ''}`),
      lastNegotiated: (id) => caps.get(`${id}\0`),
      resolveExecutable: async function (id) { return this.resolve(id); },
    };
    let agyPromptText = 'agy worker prompt';
    const agyProfile = normalizeAgentProfile({
      name: 'agy-worker',
      executor: 'agy-cli',
      modelAlias: 'model-a',
      thinkingEffort: 'medium',
      systemPrompt: () => agyPromptText,
    });
    const metadata = sessionMetadata();
    const loop = {
      _serviceBrand: undefined,
      enqueue: () => { throw new Error('unexpected enqueue'); },
      status: () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false }),
      settled: () => Promise.resolve(),
      tryAcquireQuiescence: () => ({ dispose() {} }),
      hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    } as unknown as IAgentLoopService;
    const childCtx = createTestAgent(
      {
        autoConfigure: false,
        initialConfig: {
          [AGENT_EXECUTOR_OVERRIDES_SECTION]: {
            'agy-cli': {
              quotaSource: 'plugin:magpie/agy',
              defaults: { executor_instance: 'instance-agy-a' },
            },
          },
          [AGENT_EXECUTOR_INSTANCES_SECTION]: {
            'instance-agy-a': {
              source_executor: 'agy-cli',
              label: 'Account A',
              configuration: instanceADesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-a',
            },
            'instance-agy-b': {
              source_executor: 'agy-cli',
              label: 'Account B',
              configuration: instanceBDesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-b',
            },
          },
        },
      },
      appService(IAgentExecutorRegistry, registry),
      sessionService(ISessionMetadata, metadata),
      sessionService(ISessionAgentProfileCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChange: (() => ({ dispose() {} })) as never,
        get: (name: string) => name === agyProfile.name ? agyProfile : undefined,
        getDefault: () => agyProfile,
        list: () => [agyProfile],
        listRoutes: () => [],
        routeDiagnostics: () => [],
        resolveSelection: () => ({ profile: agyProfile, baseProfile: agyProfile, route: undefined }),
        inspect: () => undefined,
        load: async () => {},
        reload: async () => {},
      }),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: CHILD, parentAgentId: 'main', agentScope: `agent/${CHILD}` })),
      agentService(IAgentExecutionService, new SyncDescriptor(AgentExecutionService)),
    );
    const childProfile = childCtx.get(IAgentProfileService);
    let childExecution = childCtx.get(IAgentExecutionService);
    await childProfile.bind({ profile: agyProfile.name, delegationPosition: 'sub' });
    expect(childProfile.data().executorId).toBe('instance-agy-a');

    const childLoop = childCtx.get(IAgentLoopService);
    childLoop.tryAcquireQuiescence = () => ({ dispose() {} });
    childLoop.status = () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false });
    const senderCtx = createTestAgent();
    const handle: IAgentScopeHandle = {
      id: CHILD,
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentExecutionService) return childExecution as T;
          if (id === IAgentLoopService) return childLoop as T;
          if (id === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) } as T;
          if (id === IAgentToolPolicyService) return { isToolActive: () => false } as T;
          return childCtx.get(id);
        },
      },
      dispose: () => {},
    };
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => senderCtx.get(id) },
      dispose: () => {},
    };
    const lifecycle = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      get: (id: string) => id === CHILD ? handle : id === 'main' ? main : undefined,
      list: () => [main, handle],
      create: async () => { throw new Error('unexpected create'); },
    } as unknown as IAgentLifecycleService;
    const toolIx = new TestInstantiationService();
    toolIx.stub(IAgentLifecycleService, lifecycle);
    toolIx.stub(ISessionMetadata, metadata);
    toolIx.stub(ISessionSubagentService, {
      hooks: createHooks(['onWillStartAgentTask']),
      retain: () => ({ dispose: () => {} }),
      notifyAgentTaskStopped: () => {},
      run: async (_agentId: string, request: import('#/session/subagent/subagent').AgentRunRequest, options: { signal: AbortSignal }) =>
        childExecution.run(request, options),
    });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, childCtx.get(IConfigService));
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    toolIx.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main', scope: (key?: string) => `agent/main/${key ?? ''}` });
    toolIx.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    toolIx.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    toolIx.stub(IAgentToolPolicyService, {
      isToolActive: () => true,
      isToolActiveForDisclosure: () => true,
      isToolActiveForProfile: () => true,
      setSessionDisabledTools: async () => {},
    });
    toolIx.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    toolIx.stub(IAgentRuntimeService, senderCtx.get(IAgentRuntimeService));
    toolIx.stub(IAgentExecutorRegistry, registry);
    toolIx.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    toolIx.set(ISubagentTool, new SyncDescriptor(SubagentTool));
    try {
      if (!legacy) remoteA.failNextTurn(new Error('AGY terminal status ERROR: RESOURCE_EXHAUSTED (code 429): Individual quota reached.'));
      const firstRun = await childExecution.run({ kind: 'prompt', prompt: 'first turn on A' }, { signal });
      await expect(firstRun.completion).rejects.toThrow(legacy ? networkError : /RESOURCE_EXHAUSTED/);
      await childExecution.settled();
      if (legacy) {
        expect(childExecution.status()).toEqual({ state: 'broken' });
        expect(caps.get('instance-agy-a\0')).toMatchObject({ resume: false, load: false });
        const saved = childCtx.get(IAgentStateService).get(externalExecutorKey);
        const { turnKey } = await import('#/agent/loop/turnOps');
        const lastTurn = childCtx.get(IAgentStateService).get(turnKey).lastEnded;
        expect(lastTurn).toMatchObject({ turnId: 0, reason: 'failed', error: { code: 'executor.protocol_error', message: networkError } });
        if (scenario === 'legacy-settled-tool-error') {
          const originalBinding = childProfile.data();
          createdSession?.updateBinding({
            ...originalBinding,
            environmentDisclosure: {
              ...originalBinding.environmentDisclosure!,
              cwd: '/spoofed-cwd',
            },
          });
          expect(childExecution.canResumeBrokenOriginal()).toBe(false);
          createdSession?.updateBinding({
            ...originalBinding,
            renderGeneration: 2,
            systemPrompt: 'changed prompt',
          });
          expect(childExecution.canResumeBrokenOriginal()).toBe(false);
          createdSession?.updateBinding({
            ...originalBinding,
            renderGeneration: 3,
          });
          expect(childExecution.canResumeBrokenOriginal()).toBe(false);
          const nonAgySession = new AcpAgentExecutorSession({
            agent: { id: CHILD, accessor: { get: <T>(id: ServiceIdentifier<T>): T => childCtx.get(id) } },
            descriptor: {
              ...instanceADesc,
              command: 'other-acp',
              instance: undefined,
            },
            binding: { ...originalBinding, renderGeneration: 2 },
          }, () => ({
            status: () => ({ state: 'broken' as const }),
            shutdown: async () => {},
            cancel: () => {},
          } as never));
          expect(nonAgySession.canResumeBrokenOriginal()).toBe(false);
          await nonAgySession.shutdown();
          createdSession?.updateBinding(originalBinding);
        }
        if (scenario === 'legacy-network') {
          await childProfile.rebuildPromptContext({ preserveUnchangedRenderGeneration: true });
          expect(childProfile.data().renderGeneration).toBe(1);
          expect(childExecution.canResumeBrokenOriginal()).toBe(true);
          agyPromptText = 'changed agy worker prompt';
          await childProfile.rebuildPromptContext({ preserveUnchangedRenderGeneration: true });
          expect(childProfile.data().renderGeneration).toBe(2);
          createdSession?.updateBinding(childProfile.data());
          expect(childExecution.canResumeBrokenOriginal()).toBe(false);
          agyPromptText = 'agy worker prompt';
          childProfile.applyBindingSnapshot({
            ...childProfile.data(),
            systemPrompt: 'agy worker prompt',
            renderGeneration: 1,
          });
          await childExecution.shutdown(new Error('simulate cold restore'));
          childExecution = childCtx.get(IInstantiationService).createInstance(AgentExecutionService);
          await childProfile.rebuildPromptContext();
          expect(childProfile.data().renderGeneration).toBe(2);
          await childProfile.rebuildPromptContext({ preserveUnchangedRenderGeneration: true });
          expect(childProfile.data().renderGeneration).toBe(2);
        }
        if (scenario !== 'legacy-network') {
          expect(childExecution.canResumeBrokenOriginal()).toBe(scenario !== 'legacy-unsettled');
        }
        oldBridge = false;
        const resumed = await executeTool(toolIx.get(ISubagentTool), {
          turnId: 2, toolCallId: 'toolu_legacy_resume',
          args: { resume: CHILD, prompt: scenario === 'legacy-network' ? '' : 'new input only', description: 'resume original native task', background: true },
          signal,
        });
        await childExecution.settled();
        if (scenario === 'legacy-unsettled') {
          expect(resumed.isError).toBe(true);
          expect(remoteA.spawns()).toBe(1);
          expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef).toEqual(saved.sessionRef);
          return;
        }
        const loads = remoteA.histories.slice(1).flatMap(history => history.sessionLoadParams);
        expect(loads.length).toBeGreaterThan(0);
        expect(loads[0]).toMatchObject({ sessionId: legacySessionId, _meta: { 'kiki.agyLegacyRecovery': {
          version: 1, sessionId: legacySessionId, conversationId: nativeId, model: 'model-a', effort: 'medium',
          terminalError: networkError.slice('AGY terminal status ERROR: '.length),
          tools: [scenario === 'legacy-settled-tool-error'
            ? { stepIndex: 2, name: 'edit_file', failed: true, error: 'file does not exist' }
            : { stepIndex: 2, name: 'read_file' }],
        } } });
        expect(remoteA.histories.slice(1).every(history => history.sessionNewParams.length === 0)).toBe(true);
        if (scenario === 'legacy-load-failure') {
          expect(resumed.isError).toBe(true);
          expect(remoteA.histories.slice(1).every(history => history.promptParams.length === 0)).toBe(true);
          expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef).toEqual(saved.sessionRef);
        } else {
          expect(resumed.isError, JSON.stringify(resumed.output)).toBeFalsy();
          expect(childProfile.data().executorId).toBe('instance-agy-a');
          expect(remoteA.histories[1]?.promptParams).toEqual([expect.objectContaining({ sessionId: legacySessionId,
            prompt: [{ type: 'text', text: scenario === 'legacy-network' ? '' : 'new input only' }] })]);
          expect(remoteB.spawns()).toBe(0);
        }
        return;
      }
      expect(childExecution.status()).toEqual({ state: 'idle' });

      const resumed = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 2,
        toolCallId: 'toolu_switch_account',
        args: {
          resume: CHILD,
          executor_instance: { account_id: 'acct-b' },
          prompt: 'second turn on B only',
          description: 'switch to account B',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumed.isError, JSON.stringify(resumed.output)).toBeFalsy();
      expect(childProfile.data().executorId).toBe('instance-agy-b');
      expect(remoteB.spawns()).toBe(1);
      expect(remoteB.opens).toHaveLength(2);
      expect(remoteB.opens[0]).toMatchObject({
        requireResume: true,
        sessionRef: { executorId: 'instance-agy-b', ref: { sessionId: 'remote-shared-1' } },
      });
      expect(remoteB.opens[1]).toMatchObject({
        requireResume: true,
        sessionRef: { executorId: 'instance-agy-b', ref: { sessionId: 'remote-shared-1' } },
      });
      expect(remoteB.histories[0]?.methods).toContain('session/load');
      expect(remoteB.histories[0]?.methods).not.toContain('session/new');
      expect(remoteB.histories[0]?.sessionLoadParams).toEqual([
        expect.objectContaining({ sessionId: 'remote-shared-1' }),
      ]);
      const promptedB = JSON.stringify(remoteB.histories[0]?.promptParams);
      expect(promptedB).toContain('second turn on B only');
      expect(promptedB).not.toContain('first turn on A');
      expect(promptedB).not.toContain('BEGIN KIKI PRIOR TRANSCRIPT HANDOFF');
      expect(promptedB.split('second turn on B only').length - 1).toBe(1);
      expect(childCtx.get(IAgentStateService).get(externalExecutorKey)).toMatchObject({
        executorId: 'instance-agy-b',
        descriptorRevision: 'r-b',
        sessionRef: { executorId: 'instance-agy-b', ref: { sessionId: 'remote-shared-1' } },
      });
    } finally {
      await toolIx.dispose();
      await childExecution.shutdown();
      await remoteA.client.shutdown();
      await remoteB.client.shutdown();
      await childCtx.dispose();
      await senderCtx.dispose();
    }
  });

  it('auto continuation policy exercises real AgentProfileService + prompt/dispatch paths: saved explicit Auto keeps A despite cached zero quota or network error, switches to B on quota failure via session/load, refuses session/new on failed load, and enforces launch home & AGY family boundaries', async () => {
    const familyDesc = {
      id: 'agy-cli',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      revision: 'r-family',
    };
    const instanceADesc = {
      id: 'instance-agy-a',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-a',
      instance: {
        id: 'instance-agy-a',
        source_executor: 'agy-cli',
        label: 'Account A',
        configuration: { kind: 'plugin_account' as const, source_id: 'plugin:magpie/agy', account_id: 'acct-a' },
        proxy: { kind: 'inherit' as const },
      },
    };
    const instanceBDesc = {
      id: 'instance-agy-b',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-b',
      instance: {
        id: 'instance-agy-b',
        source_executor: 'agy-cli',
        label: 'Account B',
        configuration: { kind: 'plugin_account' as const, source_id: 'plugin:magpie/agy', account_id: 'acct-b' },
        proxy: { kind: 'inherit' as const },
      },
    };
    const instanceCDesc = {
      id: 'instance-agy-c',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-c',
      instance: {
        id: 'instance-agy-c',
        source_executor: 'agy-cli',
        label: 'Account C',
        configuration: { kind: 'plugin_account' as const, source_id: 'plugin:magpie/agy', account_id: 'acct-c' },
        proxy: { kind: 'inherit' as const },
      },
    };
    const instanceDifferentHomeDesc = {
      id: 'instance-agy-diff-home',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      homeDir: '/isolated-agy-home',
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-diff-home',
      instance: {
        id: 'instance-agy-diff-home',
        source_executor: 'agy-cli',
        label: 'Isolated Home',
        configuration: { kind: 'config_directory' as const, path: '/isolated-agy-home' },
        proxy: { kind: 'inherit' as const },
      },
    };
    const instanceCockpitSmokeDesc = {
      id: 'instance-agy-cockpit-smoke',
      protocol: 'acp-v1' as const,
      command: 'agy-cli',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-cockpit-smoke',
      instance: {
        id: 'instance-agy-cockpit-smoke',
        source_executor: 'agy-cli',
        label: 'Legacy Cockpit Smoke',
        configuration: { kind: 'inherit' as const },
        proxy: { kind: 'inherit' as const },
      },
    };
    const grokFamilyDesc = {
      id: 'grok-acp',
      protocol: 'acp-v1' as const,
      command: 'grok',
      args: [],
      revision: 'r-grok-family',
    };
    const grokADesc = {
      id: 'instance-grok-a',
      protocol: 'acp-v1' as const,
      command: 'grok',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-grok-a',
      instance: {
        id: 'instance-grok-a',
        source_executor: 'grok-acp',
        label: 'Grok A',
        configuration: { kind: 'inherit' as const },
        proxy: { kind: 'inherit' as const },
      },
    };
    const grokBDesc = {
      id: 'instance-grok-b',
      protocol: 'acp-v1' as const,
      command: 'grok',
      args: [],
      modelBinding: 'argv' as const,
      modelArgs: ['--model', '{model}'],
      permission: argvPermission,
      revision: 'r-grok-b',
      instance: {
        id: 'instance-grok-b',
        source_executor: 'grok-acp',
        label: 'Grok B',
        configuration: { kind: 'inherit' as const },
        proxy: { kind: 'inherit' as const },
      },
    };
    let failLoadOnC = false;
    let failQuotaRead = false;
    const remoteMain = recordingClient(() => ({
      sessionId: 'remote-main-1',
      capabilities: { loadSession: true },
    }), () => false, 'agy-cli', 'agy-cli');
    const remoteCockpit = recordingClient(() => ({
      sessionId: 'remote-cockpit-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-agy-cockpit-smoke', 'agy-cli');
    const remoteA = recordingClient(() => ({
      sessionId: 'remote-auto-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-agy-a', 'agy-cli');
    const remoteB = recordingClient(() => ({
      sessionId: 'remote-auto-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-agy-b', 'agy-cli');
    const remoteC = recordingClient(() => ({
      sessionId: 'remote-auto-1',
      capabilities: { loadSession: true },
      load: failLoadOnC ? 'unknown_session' : 'ok',
    }), () => false, 'instance-agy-c', 'agy-cli');
    const remoteGrokA = recordingClient(() => ({
      sessionId: 'remote-grok-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-grok-a', 'grok-acp');
    const remoteGrokB = recordingClient(() => ({
      sessionId: 'remote-grok-1',
      capabilities: { loadSession: true },
    }), () => false, 'instance-grok-b', 'grok-acp');

    const descriptors = new Map<string, import('#/app/agentExecutor/agentExecutor').AgentExecutorDescriptor>([
      [familyDesc.id, familyDesc],
      [instanceADesc.id, instanceADesc],
      [instanceBDesc.id, instanceBDesc],
      [instanceCDesc.id, instanceCDesc],
      [instanceDifferentHomeDesc.id, instanceDifferentHomeDesc],
      [instanceCockpitSmokeDesc.id, instanceCockpitSmokeDesc],
      [grokFamilyDesc.id, grokFamilyDesc],
      [grokADesc.id, grokADesc],
      [grokBDesc.id, grokBDesc],
    ]);
    const { AcpAgentExecutorSession } = await import('#/agent/execution/acpAgentExecutorSession');
    const { AGENT_EXECUTOR_INSTANCES_SECTION } = await import('#/app/agentExecutor/executorInstances');
    const { AGENT_EXECUTOR_OVERRIDES_SECTION } = await import('#/app/agentExecutor/executorOverrides');
    const { IHarnessQuotaService } = await import('#/app/plugin/harnessQuota');
    const { normalizeAgentProfile } = await import('#/app/agentProfileCatalog/agentProfileCatalog');
    const { nativeTargets } = await import('@kiki/agent-profiles/nativeTarget');
    const { makeAgentScopeContext } = await import('#/agent/scopeContext/scopeContext');
    const { AgentExecutionService } = await import('#/agent/execution/executionService');
    const { ConfigTarget } = await import('#/app/config/config');
    const { ExecutorSessionUpdated } = await import('#/agent/execution/externalExecutorOps');
    const { agentService, appService, sessionService } = await import('../../harness');

    const caps = new Map<string, NegotiatedExecutorCapabilities>();
    const remotes = new Map([
      ['agy-cli', remoteMain], ['instance-agy-cockpit-smoke', remoteCockpit],
      ['instance-agy-c', remoteC], ['instance-agy-b', remoteB],
      ['instance-grok-a', remoteGrokA], ['instance-grok-b', remoteGrokB],
    ]);
    const provider: AgentExecutorProvider = {
      id: 'example-acp',
      protocol: 'acp-v1',
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: (ctx) => new AcpAgentExecutorSession(ctx, () =>
        (remotes.get(ctx.descriptor.id) ?? remoteA).createClient()),
    };
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      list: () => [...descriptors.values()],
      get: (id: string) => descriptors.get(id),
      resolve: (id: string) => ({ descriptor: descriptors.get(id)!, options: {}, provider }),
      validateBinding: (_id, _opts, binding) => ({ ok: true, binding }),
      discover: async () => [],
      provider: (protocol) => protocol === provider.protocol ? provider : undefined,
      recordNegotiated: (id, version, capabilities) => {
        const key = `${id}\0${version ?? ''}`;
        caps.set(key, { ...caps.get(key), ...capabilities });
      },
      negotiated: (id, version) => caps.get(`${id}\0${version ?? ''}`),
      lastNegotiated: (id) => caps.get(`${id}\0`),
      resolveExecutable: async function (id) { return this.resolve(id); },
    };

    let quotaReadings: Array<{ accountId: string; modelIds: string[]; unit: 'percent'; remaining: number | undefined }> = [
      { accountId: 'acct-a', modelIds: ['model-a'], unit: 'percent' as const, remaining: 90 },
      { accountId: 'acct-b', modelIds: ['model-a'], unit: 'percent' as const, remaining: 50 },
      { accountId: 'acct-c', modelIds: ['model-a'], unit: 'percent' as const, remaining: 40 },
    ];
    const quotaService: import('#/app/plugin/harnessQuota').IHarnessQuotaService = {
      _serviceBrand: undefined,
      definitions: async () => [],
      cached: async () => ({ sources: [] }),
      read: async () => {
        if (failQuotaRead) throw new Error('quota reader offline');
        return quotaReadings;
      },
    };

    const agyNativeTarget = nativeTargets([familyDesc])[0]!;
    const grokProfile = normalizeAgentProfile({
      name: 'grok-worker',
      executor: 'grok-acp',
      modelAlias: 'grok-4',
      thinkingEffort: 'medium',
      systemPrompt: () => 'grok worker',
    });
    const metadata = sessionMetadata();
    const loop = {
      _serviceBrand: undefined,
      enqueue: () => { throw new Error('unexpected enqueue'); },
      status: () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false }),
      settled: () => Promise.resolve(),
      tryAcquireQuiescence: () => ({ dispose() {} }),
      hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    } as unknown as IAgentLoopService;
    const childCtx = createTestAgent(
      {
        autoConfigure: false,
        initialConfig: {
          [AGENT_EXECUTOR_OVERRIDES_SECTION]: {
            'agy-cli': {
              quotaSource: 'plugin:magpie/agy',
              defaults: {
                executor_instance: 'auto',
                auto_continuation_policy: 'prefer_current',
              },
            },
          },
          [AGENT_EXECUTOR_INSTANCES_SECTION]: {
            'instance-agy-a': {
              source_executor: 'agy-cli',
              label: 'Account A',
              configuration: instanceADesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-a',
            },
            'instance-agy-b': {
              source_executor: 'agy-cli',
              label: 'Account B',
              configuration: instanceBDesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-b',
            },
            'instance-agy-c': {
              source_executor: 'agy-cli',
              label: 'Account C',
              configuration: instanceCDesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-c',
            },
            'instance-agy-diff-home': {
              source_executor: 'agy-cli',
              label: 'Isolated Home',
              configuration: instanceDifferentHomeDesc.instance.configuration,
              proxy: { kind: 'inherit' },
              quota_account_id: 'acct-diff',
            },
            'instance-agy-cockpit-smoke': {
              source_executor: 'agy-cli',
              label: 'Legacy Cockpit Smoke',
              configuration: instanceCockpitSmokeDesc.instance.configuration,
              proxy: { kind: 'inherit' },
            },
            'instance-grok-a': {
              source_executor: 'grok-acp',
              label: 'Grok A',
              configuration: grokADesc.instance.configuration,
              proxy: { kind: 'inherit' },
            },
            'instance-grok-b': {
              source_executor: 'grok-acp',
              label: 'Grok B',
              configuration: grokBDesc.instance.configuration,
              proxy: { kind: 'inherit' },
            },
          },
        },
      },
      appService(IAgentExecutorRegistry, registry),
      appService(IHarnessQuotaService, quotaService),
      sessionService(ISessionMetadata, metadata),
      sessionService(ISessionAgentProfileCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChange: (() => ({ dispose() {} })) as never,
        get: (name: string) => name === agyNativeTarget.name ? agyNativeTarget : name === grokProfile.name ? grokProfile : undefined,
        getDefault: () => agyNativeTarget,
        list: () => [agyNativeTarget, grokProfile],
        listRoutes: () => [],
        routeDiagnostics: () => [],
        resolveSelection: (sel: { profile?: string }) => {
          const picked = sel.profile === grokProfile.name ? grokProfile : agyNativeTarget;
          return { profile: picked, baseProfile: picked, route: undefined };
        },
        inspect: () => undefined,
        load: async () => {},
        reload: async () => {},
      }),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: CHILD, parentAgentId: 'main', agentScope: `agent/${CHILD}` })),
      agentService(IAgentExecutionService, new SyncDescriptor(AgentExecutionService)),
    );

    const childProfile = childCtx.get(IAgentProfileService);
    const childExecution = childCtx.get(IAgentExecutionService);
    await childProfile.bind({
      resolvedProfile: agyNativeTarget,
      execution: {
        executor: 'agy-cli',
        overrides: {
          model: 'model-a',
          thinking: 'medium',
          executor_instance: 'auto',
        },
      },
      model: 'model-a',
      thinking: 'medium',
      delegationPosition: 'sub',
    });
    expect(childProfile.data().executorId).toBe('instance-agy-a');
    expect(childProfile.data().execution?.schedule).toMatchObject({
      instance: 'instance-agy-a',
      choice: 'auto',
      source: 'session',
      quota_consulted: true,
    });

    const childLoop = childCtx.get(IAgentLoopService);
    childLoop.tryAcquireQuiescence = () => ({ dispose() {} });
    childLoop.status = () => ({ state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false });
    const senderCtx = createTestAgent();
    const handle: IAgentScopeHandle = {
      id: CHILD,
      kind: LifecycleScope.Agent,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          if (id === IAgentLoopService) return childLoop as T;
          if (id === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) } as T;
          if (id === IAgentToolPolicyService) return { isToolActive: () => false } as T;
          return childCtx.get(id);
        },
      },
      dispose: () => {},
    };
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => senderCtx.get(id) },
      dispose: () => {},
    };
    const lifecycle = {
      _serviceBrand: undefined,
      onDidCreate: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      get: (id: string) => id === CHILD ? handle : id === 'main' ? main : undefined,
      list: () => [main, handle],
      create: async () => { throw new Error('unexpected create'); },
    } as unknown as IAgentLifecycleService;
    const toolIx = new TestInstantiationService();
    toolIx.stub(IAgentLifecycleService, lifecycle);
    toolIx.stub(ISessionMetadata, metadata);
    toolIx.stub(ISessionSubagentService, {
      hooks: createHooks(['onWillStartAgentTask']),
      retain: () => ({ dispose: () => {} }),
      notifyAgentTaskStopped: () => {},
      run: async (_agentId: string, request: import('#/session/subagent/subagent').AgentRunRequest, options: { signal: AbortSignal }) =>
        childExecution.run(request, options),
    });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, childCtx.get(IConfigService));
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    toolIx.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main', scope: (key?: string) => `agent/main/${key ?? ''}` });
    toolIx.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    toolIx.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    toolIx.stub(IAgentToolPolicyService, {
      isToolActive: () => true,
      isToolActiveForDisclosure: () => true,
      isToolActiveForProfile: () => true,
      setSessionDisabledTools: async () => {},
    });
    toolIx.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    toolIx.stub(IAgentRuntimeService, senderCtx.get(IAgentRuntimeService));
    toolIx.stub(IAgentExecutorRegistry, registry);
    toolIx.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    toolIx.set(ISubagentTool, new SyncDescriptor(SubagentTool));
    try {
      const firstOk = await childExecution.run({ kind: 'prompt', prompt: 'turn 0 opens remote-auto-1 on A' }, { signal });
      await firstOk.completion;
      await childExecution.settled();
      expect(remoteA.spawns()).toBe(1);
      expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef).toMatchObject({
        executorId: 'instance-agy-a',
        ref: { sessionId: 'remote-auto-1' },
      });
      expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref['kikiLaunchHome']).toBeUndefined();

      const priorState = childCtx.get(IAgentStateService).get(externalExecutorKey);
      await childCtx.get(IEventDispatcher).dispatch(new ExecutorSessionUpdated({
        executionGeneration: priorState.executionGeneration,
        executorId: 'instance-agy-a',
        descriptorRevision: 'r-a',
        bindingFingerprint: priorState.bindingFingerprint!,
        sessionRef: { executorId: 'instance-agy-a', version: 1, ref: { sessionId: 'remote-auto-1', kikiLaunchHome: '' } },
        sessionEpoch: priorState.sessionEpoch ?? 1,
        profileDeliveredSessionId: priorState.profileDeliveredSessionId,
        profileDelivery: priorState.profileDelivery,
      }));
      await childCtx.get(IEventDispatcher).flush();

      quotaReadings = [
        { accountId: 'acct-a', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
        { accountId: 'acct-b', modelIds: ['model-a'], unit: 'percent' as const, remaining: 85 },
        { accountId: 'acct-c', modelIds: ['model-a'], unit: 'percent' as const, remaining: 40 },
      ];
      await childProfile.bind({ execution: childProfile.data().execution!.selection });
      expect(childProfile.data().executorId).toBe('instance-agy-a');
      expect(childProfile.data().execution?.schedule).toMatchObject({
        instance: 'instance-agy-a',
        choice: 'auto',
        source: 'session',
      });

      remoteA.failNextTurn(new Error('read tcp 127.0.0.1:52100->127.0.0.1:7897: wsarecv: An existing connection was forcibly closed by the remote host.'));
      const netFailRun = await childExecution.run({ kind: 'prompt', prompt: 'turn 1 network error on A' }, { signal });
      await expect(netFailRun.completion).rejects.toThrow(/wsarecv/);
      await childExecution.settled();

      const resumedAfterNet = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 2,
        toolCallId: 'toolu_resume_after_net',
        args: {
          resume: CHILD,
          prompt: 'turn 2 stays on A despite cached zero quota',
          description: 'resume after network error',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumedAfterNet.isError, JSON.stringify(resumedAfterNet.output)).toBeFalsy();
      expect(childProfile.data().executorId).toBe('instance-agy-a');
      expect(remoteB.spawns()).toBe(0);

      await expect(executeTool(toolIx.get(ISubagentTool), {
        turnId: 3,
        toolCallId: 'toolu_refuse_diff_home',
        args: {
          resume: CHILD,
          executor_instance: 'instance-agy-diff-home',
          prompt: 'must not switch to different homeDir',
          description: 'refuse different homeDir',
          background: true,
        },
        signal,
      })).resolves.toMatchObject({
        isError: true,
        output: expect.stringMatching(/original remote session cannot be resumed/i),
      });
      expect(childProfile.data().executorId).toBe('instance-agy-a');
      expect(childProfile.data().execution?.schedule?.choice).toBe('auto');

      remoteA.failNextTurn(new Error('AGY terminal status ERROR: RESOURCE_EXHAUSTED (code 429): Individual quota reached.'));
      const quotaFailRun = await childExecution.run({ kind: 'prompt', prompt: 'turn 3 quota exhausted on A' }, { signal });
      await expect(quotaFailRun.completion).rejects.toThrow(/RESOURCE_EXHAUSTED/);
      await childExecution.settled();

      const resumedAfterQuota = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 4,
        toolCallId: 'toolu_resume_after_quota',
        args: {
          resume: CHILD,
          prompt: 'turn 4 auto switches to B via session/load',
          description: 'auto switch after quota error',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumedAfterQuota.isError, JSON.stringify(resumedAfterQuota.output)).toBeFalsy();
      expect(childProfile.data().executorId).toBe('instance-agy-b');
      expect(childProfile.data().execution?.schedule).toMatchObject({
        instance: 'instance-agy-b',
        choice: 'auto',
      });
      expect(remoteB.spawns()).toBe(1);
      expect(remoteB.histories[0]?.methods).toContain('session/load');
      expect(remoteB.histories[0]?.methods).not.toContain('session/new');
      expect(remoteB.histories[0]?.sessionLoadParams).toEqual([
        expect.objectContaining({ sessionId: 'remote-auto-1' }),
      ]);

      childCtx.get(IConfigService).set(AGENT_EXECUTOR_OVERRIDES_SECTION, {
        'agy-cli': {
          quotaSource: 'plugin:magpie/agy',
          defaults: {
            executor_instance: 'auto',
            auto_continuation_policy: 'prefer_quota',
          },
        },
      }, ConfigTarget.Memory);
      quotaReadings = [
        { accountId: 'acct-a', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
        { accountId: 'acct-b', modelIds: ['model-a'], unit: 'percent' as const, remaining: 10 },
        { accountId: 'acct-c', modelIds: ['model-a'], unit: 'percent' as const, remaining: 95 },
      ];
      failLoadOnC = true;
      await childProfile.bind({ execution: childProfile.data().execution!.selection });
      expect(childProfile.data().executorId).toBe('instance-agy-c');
      await expect(childExecution.run({ kind: 'prompt', prompt: 'turn 5 must not send when load fails on C' }, { signal })).rejects.toThrow(/requested external session cannot be resumed or loaded/);
      await childExecution.settled();
      expect(remoteC.spawns()).toBe(2);
      expect(remoteC.histories[0]?.methods).toContain('session/load');
      expect(remoteC.histories[0]?.methods).not.toContain('session/new');
      expect(remoteC.histories[0]?.methods).not.toContain('session/prompt');
      expect(remoteC.histories[1]?.methods).toContain('session/load');
      expect(remoteC.histories[1]?.methods).not.toContain('session/new');
      expect(remoteC.histories[1]?.methods).not.toContain('session/prompt');

      failLoadOnC = false;
      const resumedPreferQuota = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 5,
        toolCallId: 'toolu_resume_prefer_quota',
        args: {
          resume: CHILD,
          prompt: 'turn 6 prefer_quota loads session on C',
          description: 'prefer quota switch to C',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumedPreferQuota.isError, JSON.stringify(resumedPreferQuota.output)).toBeFalsy();
      expect(childProfile.data().executorId).toBe('instance-agy-c');
      expect(remoteC.histories.at(-1)?.sessionLoadParams).toEqual([
        expect.objectContaining({ sessionId: 'remote-auto-1' }),
      ]);
      expect(remoteC.histories.at(-1)?.methods).not.toContain('session/new');
      expect(JSON.stringify(remoteC.histories.at(-1)?.promptParams)).toContain('turn 6 prefer_quota loads session on C');
      expect(JSON.stringify(remoteC.histories.at(-1)?.promptParams)).not.toContain('turn 5 must not send');

      quotaReadings = [
        { accountId: 'acct-a', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
        { accountId: 'acct-b', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
        { accountId: 'acct-c', modelIds: ['model-a'], unit: 'percent' as const, remaining: undefined },
        { accountId: 'acct-diff', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
      ];
      childCtx.get(IConfigService).set(AGENT_EXECUTOR_OVERRIDES_SECTION, {
        'agy-cli': {
          quotaSource: 'plugin:magpie/agy',
          defaults: {
            executor_instance: 'auto',
            auto_continuation_policy: 'prefer_current',
          },
        },
      }, ConfigTarget.Memory);
      await childProfile.bind({
        resolvedProfile: agyNativeTarget,
        execution: {
          executor: 'agy-cli',
          overrides: {
            model: 'model-a',
            thinking: 'medium',
            executor_instance: 'main',
          },
        },
        model: 'model-a',
        thinking: 'medium',
        delegationPosition: 'sub',
      });
      await childCtx.get(IEventDispatcher).dispatch(new ExecutorSessionUpdated({
        executionGeneration: childProfile.data().execution?.generation,
        executorId: 'agy-cli',
        descriptorRevision: 'r-main',
        bindingFingerprint: agentExecutorBindingFingerprint(childProfile.data()),
        sessionRef: { executorId: 'agy-cli', version: 1, ref: { sessionId: 'remote-main-1' } },
        sessionEpoch: 2,
        profileDeliveredSessionId: 'remote-main-1',
        profileDelivery: 'first_prompt_preamble',
      }));
      await childCtx.get(IEventDispatcher).flush();
      await childProfile.bind({
        resolvedProfile: agyNativeTarget,
        execution: {
          executor: 'agy-cli',
          overrides: {
            model: 'model-a',
            thinking: 'medium',
            executor_instance: 'auto',
          },
        },
        model: 'model-a',
        thinking: 'medium',
        delegationPosition: 'sub',
      });
      expect(childProfile.data().executorId).toBe('agy-cli');
      expect(childProfile.data().execution?.schedule).toMatchObject({
        instance: 'main',
        choice: 'auto',
      });

      const runOnMain = await childExecution.run({ kind: 'prompt', prompt: 'turn 7 initial run on main before quota failure' }, { signal });
      await runOnMain.completion;
      await childExecution.settled();
      expect(remoteMain.histories).toHaveLength(1);
      expect(remoteMain.histories[0]?.methods).toContain('session/load');
      expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref).toMatchObject({
        sessionId: 'remote-main-1',
      });

      remoteMain.failNextTurn(new Error('429 RESOURCE_EXHAUSTED: main account quota exhausted'));
      const mainQuotaFailRun = await childExecution.run({ kind: 'prompt', prompt: 'turn 8 quota exhausted on main' }, { signal });
      await expect(mainQuotaFailRun.completion).rejects.toThrow(/RESOURCE_EXHAUSTED/);
      await childExecution.settled();

      const histCountsBeforeExhausted = {
        main: remoteMain.histories.length,
        cockpit: remoteCockpit.histories.length,
        a: remoteA.histories.length,
        b: remoteB.histories.length,
        c: remoteC.histories.length,
      };

      await expect(childProfile.bind({
        execution: childProfile.data().execution!.selection,
      })).rejects.toThrow(/No available executor instance with positive quota/i);

      const resumeWhenAllZero = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 8,
        toolCallId: 'toolu_resume_main_all_zero',
        args: {
          resume: CHILD,
          prompt: 'turn 8 must not launch when all accounts are 0 or unknown',
          description: 'all zero after main quota failure',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumeWhenAllZero.isError).toBe(true);
      expect(JSON.stringify(resumeWhenAllZero.output)).toMatch(/No available executor instance with positive quota/i);

      failQuotaRead = true;
      await expect(childProfile.bind({
        execution: childProfile.data().execution!.selection,
      })).rejects.toThrow(/No available executor instance with positive quota/i);

      const resumeWhenReaderThrows = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 9,
        toolCallId: 'toolu_resume_main_reader_throws',
        args: {
          resume: CHILD,
          prompt: 'turn 9 must not launch when quota reader throws',
          description: 'reader throws after main quota failure',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumeWhenReaderThrows.isError).toBe(true);
      expect(JSON.stringify(resumeWhenReaderThrows.output)).toMatch(/No available executor instance with positive quota/i);

      expect({
        main: remoteMain.histories.length,
        cockpit: remoteCockpit.histories.length,
        a: remoteA.histories.length,
        b: remoteB.histories.length,
        c: remoteC.histories.length,
      }).toEqual(histCountsBeforeExhausted);
      expect(remoteCockpit.histories).toHaveLength(0);
      expect(childProfile.data().executorId).toBe('agy-cli');
      expect(childProfile.data().execution?.schedule).toMatchObject({
        instance: 'main',
        choice: 'auto',
      });
      expect(childCtx.get(IAgentStateService).get(externalExecutorKey).sessionRef?.ref).toMatchObject({
        sessionId: 'remote-main-1',
      });

      failQuotaRead = false;
      quotaReadings = [
        { accountId: 'acct-a', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
        { accountId: 'acct-b', modelIds: ['model-a'], unit: 'percent' as const, remaining: 75 },
        { accountId: 'acct-c', modelIds: ['model-a'], unit: 'percent' as const, remaining: undefined },
        { accountId: 'acct-diff', modelIds: ['model-a'], unit: 'percent' as const, remaining: 0 },
      ];
      const resumeAfterQuotaRestored = await executeTool(toolIx.get(ISubagentTool), {
        turnId: 10,
        toolCallId: 'toolu_resume_main_to_b',
        args: {
          resume: CHILD,
          prompt: 'turn 10 switches from failed main to B and loads remote-main-1',
          description: 'recover to B after quota restored',
          background: true,
        },
        signal,
      });
      await childExecution.settled();
      expect(resumeAfterQuotaRestored.isError, JSON.stringify(resumeAfterQuotaRestored.output)).toBeFalsy();
      expect(childProfile.data().executorId).toBe('instance-agy-b');
      expect(childProfile.data().execution?.schedule).toMatchObject({
        instance: 'instance-agy-b',
        choice: 'auto',
        quota_consulted: true,
      });
      expect(remoteB.histories.at(-1)?.sessionLoadParams).toEqual([
        expect.objectContaining({ sessionId: 'remote-main-1' }),
      ]);
      expect(remoteB.histories.at(-1)?.methods).not.toContain('session/new');
      expect(JSON.stringify(remoteB.histories.at(-1)?.promptParams)).toContain('turn 10 switches from failed main to B and loads remote-main-1');
      expect(JSON.stringify(remoteB.histories.at(-1)?.promptParams)).not.toContain('turn 8 must not launch');
      expect(JSON.stringify(remoteB.histories.at(-1)?.promptParams)).not.toContain('turn 9 must not launch');

      const grokNativeTarget = nativeTargets([grokFamilyDesc])[0]!;
      await childProfile.bind({
        resolvedProfile: grokNativeTarget,
        execution: {
          executor: 'grok-acp',
          overrides: {
            model: 'grok-4',
            thinking: 'medium',
            executor_instance: 'instance-grok-a',
          },
        },
        model: 'grok-4',
        thinking: 'medium',
        delegationPosition: 'sub',
      });
      await childCtx.get(IEventDispatcher).dispatch(new ExecutorSessionUpdated({
        executionGeneration: childProfile.data().execution?.generation,
        executorId: 'instance-grok-a',
        descriptorRevision: 'r-grok-a',
        bindingFingerprint: 'fp-grok-a',
        sessionRef: { executorId: 'instance-grok-a', version: 1, ref: { sessionId: 'remote-grok-1', kikiLaunchHome: '' } },
        sessionEpoch: 1,
      }));
      await childCtx.get(IEventDispatcher).flush();
      await expect(childProfile.prepareResumeBinding({ executorInstance: 'instance-grok-b' })).rejects.toThrow(/original remote session cannot be resumed/i);
    } finally {
      await toolIx.dispose();
      await childExecution.shutdown();
      await remoteMain.client.shutdown();
      await remoteCockpit.client.shutdown();
      await remoteA.client.shutdown();
      await remoteB.client.shutdown();
      await remoteC.client.shutdown();
      await remoteGrokA.client.shutdown();
      await remoteGrokB.client.shutdown();
      await childCtx.dispose();
      await senderCtx.dispose();
    }
  });
});
