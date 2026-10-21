import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '../../../../acp-client/node_modules/@agentclientprotocol/sdk/dist/acp.js';
import { AcpProcessClient, type AcpOpenSessionOptions } from '@kiki/acp-client';
import type { HostProcessLike } from '@kiki/acp-client';
import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
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
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { externalExecutorKey } from '#/agent/execution/externalExecutorOps';
import { createTestAgent } from '../../harness';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { createInProcessScriptedAgent, type InProcessAgentScript } from '../../../../acp-client/test/fixtures/in-process-scripted-agent';

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

function recordingClient(script: () => InProcessAgentScript, failSpawn: () => boolean) {
  const opens: AcpOpenSessionOptions[] = [];
  const histories: Array<ReturnType<typeof createInProcessScriptedAgent>['history']> = [];
  let spawns = 0;
  const client = new AcpProcessClient({
    spawn: async () => {
      spawns += 1;
      if (failSpawn()) throw new Error('spawn failed');
      const { child, toAgent, fromAgent } = scriptedChild();
      const fixture = createInProcessScriptedAgent(script());
      histories.push(fixture.history);
      fixture.app.connect(ndJsonStream(Writable.toWeb(fromAgent), Readable.toWeb(toAgent)));
      return child;
    },
  }, { id: 'example-acp', command: 'example-acp', startupTimeoutMs: 5_000 }, { platform: 'linux' });
  const openSession = client.openSession.bind(client);
  client.openSession = (async (options: AcpOpenSessionOptions) => {
    opens.push(options);
    return openSession(options);
  }) as typeof client.openSession;
  return { client, opens, histories, spawns: () => spawns };
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
    updateAgent: async (agentId, update) => {
      const current = agents[agentId];
      if (current !== undefined) agents[agentId] = update(current);
    },
    getAgentExecutor: async () => undefined,
    registerAgent: async () => {},
    createdByLoad: () => true,
  } as unknown as ISessionMetadata & { agents: Record<string, AgentMeta> };
}

function modelSwitchFor(executionIx: TestInstantiationService, metadata: ISessionMetadata) {
  const state = executionIx.get(IAgentStateService);
  state.contributeState(contextRevisionKey);
  state.contributeState(contextWindowEpochKey);
  const ix = new TestInstantiationService();
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
    messagingIx.set(IAgentCollaborationMessageStore, mailbox.store);
    messagingIx.set(IAgentLifecycleService, lifecycle);
    messagingIx.set(ISessionContext, session);
    messagingIx.set(ISessionMetadata, metadata);
    messagingIx.stub(ISessionDispatchService, { runOnExisting: async () => { throw new Error('AgentSend must not dispatch while broken'); } });
    messagingIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {} });
    messagingIx.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
    const messaging = messagingIx.get(IAgentCollaborationMessagingService);
    const toolIx = new TestInstantiationService();
    toolIx.stub(IAgentLifecycleService, lifecycle);
    toolIx.stub(ISessionMetadata, metadata);
    toolIx.stub(ISessionSubagentService, {
      hooks: createHooks(['onWillStartAgentTask']),
      notifyAgentTaskStopped: () => {},
      run: async (_agentId: string, request: import('#/session/subagent/subagent').AgentRunRequest, options: { signal: AbortSignal }) =>
        harness.execution.run(request, options),
    });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {} });
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
    toolIx.stub(IAgentRuntimeService, { acquire: () => ({ runtime: {}, dispose: () => {} }) });
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

      expect(result.isError, String(result.output)).toBeFalsy();
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
      expect(String(result.output)).not.toContain(BODY);
    } finally {
      messaging.dispose();
      messagingIx.dispose();
      toolIx.dispose();
      switched.dispose();
      await harness.execution.shutdown().catch(() => undefined);
      await remote.client.shutdown().catch(() => undefined);
      harness.ix.dispose();
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
          if (id === IAgentProfileService) return harness.ix.get(IAgentProfileService);
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
    toolIx.stub(ISessionSubagentService, { hooks: createHooks(['onWillStartAgentTask']), notifyAgentTaskStopped: () => {}, run: async () => { throw new Error('unrecoverable broken must not start'); } });
    toolIx.stub(ISessionAgentProfileCatalog, { ready: Promise.resolve(), list: () => [], listRoutes: () => [], get: () => undefined });
    toolIx.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    toolIx.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    toolIx.stub(IModelCatalog, {});
    toolIx.stub(IModelService, {});
    toolIx.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {} });
    toolIx.stub(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'main', scope: () => 'agent/main' });
    toolIx.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    toolIx.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    toolIx.stub(IAgentToolPolicyService, { isToolActive: () => true, isToolActiveForDisclosure: () => true, isToolActiveForProfile: () => true, setSessionDisabledTools: async () => {} });
    toolIx.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    toolIx.stub(IAgentRuntimeService, { acquire: () => ({ runtime: {}, dispose: () => {} }) });
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
      expect(String(result.output)).toContain('original remote session cannot be resumed');
      expect(String(result.output)).not.toContain('already running');
      expect(remote.spawns()).toBe(spawned);
      expect(remote.histories.every((history) => history.sessionNewParams.length === 0)).toBe(true);
    } finally {
      toolIx.dispose();
      await harness.execution.shutdown().catch(() => undefined);
      await remote.client.shutdown().catch(() => undefined);
      harness.ix.dispose();
      await senderCtx.dispose();
    }
  });
});
