import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type IWaitUntil } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import type { ErrorCode } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { TokenUsage } from '#/kosong/contract/usage';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
  IAgentCollaborationRegistry,
} from '#/session/agentCollaboration/registry';
import {
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import { ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import {
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  type ExternalAuthority,
  ISessionExternalDelegationService,
} from '#/session/externalDelegation/externalDelegation';
import { SessionExternalDelegationService } from '#/session/externalDelegation/externalDelegationService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionQuestionService } from '#/session/question/question';
import { SessionQuestionService } from '#/session/question/questionService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IModelService } from '#/kosong/model/model';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import type { SessionWillCloseEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';

const authority: ExternalAuthority = {
  principalFingerprint: 'a'.repeat(64),
  authorityFingerprint: 'b'.repeat(64),
  configFingerprint: 'c'.repeat(64),
};

const profile: AgentProfile = {
  name: 'coder',
  description: 'Code owner',
  modelAlias: 'model',
  systemPrompt: () => 'coder',
  renderSystemPrompt: () => ({ text: 'coder', environment: { cwd: '', date: { disclosed: false } } }),
};

describe('SessionExternalDelegationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let documents: Map<string, unknown>;
  let handles: Map<string, IAgentScopeHandle>;
  let agentMetas: Record<string, AgentMeta>;
  let completions: Array<{ resolve(value: { summary: string; usage?: TokenUsage }): void; reject(error: unknown): void }>;
  let nextRunHandleGate: Promise<void> | undefined;
  let onRunAbort: ((agentId: string) => void) | undefined;
  let runSignals: AbortSignal[];
  let runAgentIds: string[];
  let runPrompts: string[];
  let createdWith: unknown[];
  let willClose: Emitter<SessionWillCloseEvent & IWaitUntil>;
  let logCalls: Array<{ msg: string; payload: unknown }>;
  let sentMessages: Parameters<IAgentCollaborationMessagingService['send']>[0][];
  let messagesByKey: Map<string, AgentMessageAcceptance>;
  let wireRecords: Map<string, WireRecord[]>;
  let journalReads: Map<string, number>;
  let journalYield: (() => Promise<void>) | undefined;
  let nextTurnIds: Map<string, number>;
  let fakeExecutorApprovalResponses: unknown[];
  let permissionModes: Map<string, PermissionMode>;
  let nextCreatedAgentId: string | undefined;
  let bootstrapEnv: Record<string, string | undefined>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    documents = new Map();
    const documentStore = documents;
    handles = new Map();
    agentMetas = { main: { type: 'main', labels: {} } };
    completions = [];
    nextRunHandleGate = undefined;
    onRunAbort = undefined;
    runSignals = [];
    runAgentIds = [];
    runPrompts = [];
    createdWith = [];
    logCalls = [];
    sentMessages = [];
    messagesByKey = new Map();
    wireRecords = new Map();
    journalReads = new Map();
    journalYield = undefined;
    nextTurnIds = new Map();
    fakeExecutorApprovalResponses = [];
    permissionModes = new Map();
    nextCreatedAgentId = undefined;
    bootstrapEnv = {};

    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IAtomicDocumentStore, {
      _serviceBrand: undefined,
      get: async <T>(_scope: string, key: string) => documentStore.get(key) as T | undefined,
      set: async (_scope, key, value) => { documentStore.set(key, structuredClone(value)); },
      delete: async () => {},
      list: async () => [],
      watch: () => () => ({ dispose: () => {} }),
      acquire: () => ({ dispose: () => {} }),
    });
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'session_test',
      workspaceId: 'workspace_test',
      sessionDir: '',
      metaScope: '',
      cwd: '/workspace',
      scope: (key?: string) => `session/${key ?? ''}`,
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: async () => ({
        id: 'session_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: agentMetas,
      }),
      registerAgent: async (agentId, meta) => {
        agentMetas[agentId] = meta;
      },
    });
    ix.stub(ISessionWorkspaceContext, { _serviceBrand: undefined, workDir: '/workspace', additionalDirs: [] });
    ix.stub(IBootstrapService, { getEnv: (name) => bootstrapEnv[name] });
    ix.stub(IConfigService, { get: <T>() => undefined as T });
    ix.stub(IModelService, { resolveId: (id: string) => id });
    ix.stub(IModelCatalog, {
      get: (id: string) => ({ id }) as Model,
    } as IModelCatalog);
    willClose = new Emitter<SessionWillCloseEvent & IWaitUntil>();
    disposables.add(willClose);
    ix.set(ISessionManager, {
      _serviceBrand: undefined,
      onWillCloseSession: willClose.event,
    } as unknown as ISessionManager);
    ix.stub(ILogService, {
      _serviceBrand: undefined,
      level: 'off',
      error: (msg: string, payload: unknown) => { logCalls.push({ msg, payload }); },
      warn: () => {},
      info: () => {},
      debug: () => {},
      setLevel: () => {},
      flush: async () => {},
      child: () => ix.get(ILogService),
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : undefined,
      getDefault: () => profile,
      list: () => [profile],
    });

    const makeHandle = (
      id: string,
      profileName: string,
      modelAlias = 'model',
      thinkingLevel = 'off',
      profileDefinitionId?: string,
      executorId = 'native',
    ): IAgentScopeHandle => {
      const agent = new TestInstantiationService();
      disposables.add(agent);
      const wireEvents = disposables.add(new Emitter<Event2<unknown>>());
      const records: WireRecord[] = [];
      const push = records.push.bind(records);
      records.push = (...items) => {
        const length = push(...items);
        for (const record of items) {
          wireEvents.fire({
            type: record.type,
            constructor: { durable: true },
          } as unknown as Event2<unknown>);
        }
        return length;
      };
      wireRecords.set(id, records);
      agent.set(IEventBus, {
        _serviceBrand: undefined,
        publish: (event) => wireEvents.fire(event),
        subscribe: ((handler: (event: Event2<unknown>) => void) =>
          wireEvents.event(handler)) as IEventBus['subscribe'],
      });
      agent.set(IWireService, {
        _serviceBrand: undefined,
        seal: async () => {},
        appendRecord: (record: WireRecord) => { wireRecords.get(id)!.push(record); },
        readJournal: () => {
          journalReads.set(id, (journalReads.get(id) ?? 0) + 1);
          return (async function* () {
            for (const record of wireRecords.get(id)!) {
              await journalYield?.();
              yield record;
            }
          })();
        },
        flush: async () => {},
      });
      agent.stub(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => ({ modelAlias, modelCapabilities: UNKNOWN_CAPABILITY, profileName, profileDefinitionId, thinkingLevel, systemPrompt: '', executorId, subagents: ['coder'] }),
      });
      permissionModes.set(id, 'auto');
      agent.stub(IAgentPermissionModeService, {
        get mode() {
          return permissionModes.get(id)!;
        },
        setMode: (mode) => permissionModes.set(id, mode),
      });
      agent.stub(IAgentUserToolService, { list: () => [], inheritUserTools: () => {} });
      const runtime = new FakeRuntime(
        { workspaceId: 'workspace_test', runtimeId: 'local', generation: 'test' },
        { capabilities: ['process'] },
      );
      agent.set(IAgentRuntimeService, {
        _serviceBrand: undefined,
        onDidChange: () => ({ dispose: () => {} }),
        inspect: () => runtime,
        isAvailable: () => true,
        acquire: () => ({ runtime, dispose: () => {}, track: () => {} }),
      } as unknown as IAgentRuntimeService);
      agent.stub(IAgentContextMemoryService, { get: () => [] });
      agent.stub(IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) });
      agent.stub(IAgentExecutionService, { status: () => ({ state: 'idle' }) });
      return { id, accessor: agent } as unknown as IAgentScopeHandle;
    };
    handles.set('main', makeHandle('main', 'agent'));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      get: (id) => handles.get(id),
      create: async (opts) => {
        createdWith.push(opts);
        const agentId = opts?.agentId ?? nextCreatedAgentId ?? 'external-child';
        nextCreatedAgentId = undefined;
        const handle = makeHandle(
          agentId,
          opts?.binding?.profile ?? 'coder',
          opts?.binding?.model,
          opts?.binding?.thinking,
          opts?.binding?.resolvedProfile?.definitionId,
          opts?.binding?.resolvedProfile?.executor,
        );
        handles.set(handle.id, handle);
        agentMetas[handle.id] = {
          type: 'sub',
          delegator: opts?.delegator,
          labels: opts?.labels,
          displayName: opts?.binding?.profile,
        };
        return handle;
      },
    });
    ix.stub(ISessionSubagentService, {
      _serviceBrand: undefined,
      run: async (agentId, request, opts) => {
        runAgentIds.push(agentId);
        if (request.kind === 'prompt') runPrompts.push(request.prompt);
        runSignals.push(opts.signal);
        const gate = nextRunHandleGate;
        nextRunHandleGate = undefined;
        if (gate !== undefined) await gate;
        const binding = handles.get(agentId)!.accessor.get(IAgentProfileService).data();
        if (binding.executorId === 'fake-executor') {
          const response = await ix.get(ISessionApprovalService).request({
            id: `fake-executor-permission-${agentId}`,
            agentId,
            toolName: 'external',
            action: 'run',
            display: {
              kind: 'external_permission',
              summary: 'Run fake external tool',
              options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow_once' }],
            },
          });
          fakeExecutorApprovalResponses.push(response);
        }
        const turnId = (nextTurnIds.get(agentId) ?? 0) + 1;
        nextTurnIds.set(agentId, turnId);
        const turn = { id: turnId };
        const journalStart = wireRecords.get(agentId)!.length;
        const ensureTurnEnded = (reason: 'completed' | 'failed' | 'cancelled'): void => {
          const records = wireRecords.get(agentId)!;
          let ended = records.slice(journalStart).findLast((record) => record.type === 'turn.ended');
          if (ended === undefined) {
            const lastTime = records.reduce(
              (time, record) => typeof record.time === 'number' ? Math.max(time, record.time) : time,
              0,
            );
            if (!records.some((record) => record.type === 'turn.prompt' && record['turnId'] === turnId)) {
              records.push({
                type: 'turn.prompt',
                time: lastTime + 1,
                turnId,
                input: [{ type: 'text', text: request.kind === 'prompt' ? request.prompt : 'retry' }],
                origin: { kind: 'user' },
              });
            }
            records.push({ type: 'turn.ended', time: lastTime + 2, turnId, reason });
            ended = records.at(-1)!;
          }
          turn.id = ended['turnId'] as number;
        };
        let resolvePromise!: (value: { summary: string; usage?: TokenUsage }) => void;
        let rejectPromise!: (error: unknown) => void;
        const completion = new Promise<{ summary: string; usage?: TokenUsage }>((res, rej) => {
          resolvePromise = res;
          rejectPromise = rej;
        });
        const resolve = (value: { summary: string; usage?: TokenUsage }): void => {
          ensureTurnEnded('completed');
          resolvePromise(value);
        };
        const reject = (error: unknown): void => {
          ensureTurnEnded(opts.signal.aborted ? 'cancelled' : 'failed');
          rejectPromise(error);
        };
        completions.push({ resolve, reject });
        const abort = (): void => {
          onRunAbort?.(agentId);
          reject(opts.signal.reason);
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener('abort', abort, { once: true });
        return { agentId, turn: turn as never, completion };
      },
    });
    ix.stub(IAgentCollaborationRegistry, {
      _serviceBrand: undefined,
      reserve: async () => true,
      commit: () => {},
      release: () => {},
    });
    ix.stub(IAgentCollaborationMessagingService, {
      _serviceBrand: undefined,
      send: async (input) => {
        sentMessages.push(input);
        const prior = messagesByKey.get(input.idempotencyKey);
        if (prior !== undefined) {
          return {
            ...prior,
            deduplicated: true,
            payloadConflict: prior.message.content !== input.content,
          };
        }
        const acceptance: AgentMessageAcceptance = {
          message: {
            messageId: `message-${String(messagesByKey.size + 1)}`,
            sessionId: 'session_test',
            sourceAgentId: input.sourceAgentId,
            sourceTaskName: input.sourceTaskName,
            targetAgentId: input.targetAgentId,
            targetTaskName: input.targetTaskName,
            content: input.content,
            acceptedAt: 1,
            targetSeq: messagesByKey.size + 1,
          },
          deduplicated: false,
          delivery: 'queued',
          payloadConflict: false,
        };
        messagesByKey.set(input.idempotencyKey, acceptance);
        return acceptance;
      },
    });
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
    ix.set(ISessionQuestionService, new SyncDescriptor(SessionQuestionService));
    ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    ix.set(ISessionExternalDelegationService, new SyncDescriptor(SessionExternalDelegationService));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('owns named work under an external root and enforces one active dispatch', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const first = await service.dispatch({ authority, target: 'named', taskName: 'reviewer', profileName: 'coder', message: 'review' });
    expect(first.status).toBe('queued');
    expect(createdWith[0]).toMatchObject({
      runtimeId: 'local',
      delegator: { kind: 'external', delegationId: expect.stringMatching(/^delegation_/) },
      labels: { [COLLABORATION_TASK_NAME_LABEL]: 'reviewer' },
    });
    expect(createdWith[0]).not.toMatchObject({
      labels: {
        externalDelegationTaskName: expect.anything(),
        externalDelegationProfile: expect.anything(),
      },
    });
    await expect(service.dispatch({ authority, target: 'named', taskName: 'reviewer', message: 'again' })).rejects.toThrow(/active dispatch/);

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: first.dispatchId })).status).toBe(
        'completed',
      );
    });
    const continued = await service.continue({ authority, dispatchId: first.dispatchId, message: 'continue' });
    expect(continued.continuationOf).toBe(first.dispatchId);
    expect(createdWith).toHaveLength(1);
  });

  it('releases a dispatch key when the durable queue write fails', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    await service.list(authority);
    vi.spyOn(ix.get(IAtomicDocumentStore), 'set').mockRejectedValueOnce(new Error('write failed'));

    await expect(service.dispatch({
      authority,
      target: 'named',
      taskName: 'retry_child',
      profileName: 'coder',
      message: 'work',
      dispatchKey: 'retry-key',
    })).rejects.toThrow('write failed');
    const afterFailure = documents.get('root') as {
      children: Record<string, unknown>;
      dispatches: Record<string, unknown>;
      dispatchKeys?: Record<string, unknown>;
      nextEventSeq: number;
    };
    expect(afterFailure.children).toEqual({});
    expect(afterFailure.dispatches).toEqual({});
    expect(afterFailure.dispatchKeys).toBeUndefined();
    expect(afterFailure.nextEventSeq).toBe(1);

    const retried = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'retry_child',
      profileName: 'coder',
      message: 'work',
      dispatchKey: 'retry-key',
    });
    expect(retried.status).toBe('queued');
    expect(runAgentIds).toEqual(['external-child']);
    expect(createdWith).toHaveLength(1);
    expect(completions).toHaveLength(1);
  });

  it('queues idempotent mailbox messages only for an owned named child', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'mailbox_child',
      profileName: 'coder',
      message: 'create',
    });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    const first = await service.send({
      authority,
      taskName: 'mailbox_child',
      message: 'review the update',
      idempotencyKey: 'message-key',
    });
    const replay = await service.send({
      authority,
      taskName: 'mailbox_child',
      message: 'review the update',
      idempotencyKey: 'message-key',
    });

    expect(first.deduplicated).toBe(false);
    expect(replay).toMatchObject({
      message: { messageId: first.message.messageId },
      deduplicated: true,
      payloadConflict: false,
    });
    expect(sentMessages).toEqual([
      {
        sourceAgentId: expect.stringMatching(/^external:delegation_/),
        sourceTaskName: 'external',
        targetAgentId: 'external-child',
        targetTaskName: 'mailbox_child',
        content: 'review the update',
        idempotencyKey: 'message-key',
      },
      expect.objectContaining({ idempotencyKey: 'message-key' }),
    ]);
    await expect(service.send({
      authority,
      taskName: 'missing_child',
      message: 'reject',
      idempotencyKey: 'missing-key',
    })).rejects.toThrow(/Unknown named child/);
    await expect(service.send({
      authority: { ...authority, principalFingerprint: 'd'.repeat(64) },
      taskName: 'mailbox_child',
      message: 'reject',
      idempotencyKey: 'foreign-key',
    })).rejects.toThrow(/does not own/);
  });

  it('registers scoped interaction coverage only while dispatches are active', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const interaction = ix.get(ISessionInteractionService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'approval_child',
      profileName: 'coder',
      message: 'inspect',
    });

    expect(interaction.hasConsumer({ agentId: 'external-child' })).toBe(true);
    expect(interaction.hasConsumer({ agentId: 'main' })).toBe(false);

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
    expect(interaction.hasConsumer({ agentId: 'external-child' })).toBe(false);
  });

  it('wakes wait with owned pending interactions', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const approvals = ix.get(ISessionApprovalService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'waiting_child',
      profileName: 'coder',
      message: 'inspect',
    });
    const waiting = service.wait({
      authority,
      dispatchId: dispatch.dispatchId,
      timeoutMs: 5_000,
    });
    const approval = approvals.request({
      id: 'approval-waiting',
      agentId: 'external-child',
      turnId: 1,
      toolName: 'bash',
      action: 'run',
      display: { kind: 'command', command: 'pwd' },
    });

    await expect(waiting).resolves.toMatchObject({
      waitStatus: 'interaction_pending',
      dispatch: { dispatchId: dispatch.dispatchId },
      interactions: [{
        interactionId: 'approval-waiting',
        kind: 'approval',
        taskName: 'waiting_child',
      }],
    });
    await service.respond({
      authority,
      interactionId: 'approval-waiting',
      kind: 'approval',
      response: { decision: 'approved' },
    });
    await expect(approval).resolves.toEqual({ decision: 'approved' });
    completions[0]!.resolve({ summary: 'done' });
  });

  it('routes main interactions to the external caller during a main dispatch', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const approvals = ix.get(ISessionApprovalService);
    const dispatch = await service.dispatch({
      authority,
      target: 'main',
      message: 'inspect',
    });
    const approval = approvals.request({
      id: 'approval-main-owned',
      agentId: 'main',
      turnId: 1,
      toolName: 'bash',
      action: 'run',
      display: { kind: 'command', command: 'pwd' },
    });

    expect(await service.interactions({ authority })).toMatchObject({
      items: [{
        interactionId: 'approval-main-owned',
        kind: 'approval',
        taskName: 'main',
      }],
    });
    await service.respond({
      authority,
      interactionId: 'approval-main-owned',
      kind: 'approval',
      response: { decision: 'approved' },
    });
    await expect(approval).resolves.toEqual({ decision: 'approved' });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
  });

  it('exposes and answers a grandchild interaction through its owned dispatch subtree', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const approvals = ix.get(ISessionApprovalService);
    const rootDispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'root_child',
      profileName: 'coder',
      message: 'inspect',
    });
    const parent = handles.get('external-child')!;
    const runtimeLease = parent.accessor.get(IAgentRuntimeService).acquire(['process']);
    nextCreatedAgentId = 'grandchild';
    const nestedRun = await ix.get(ISessionDispatchService).launch({
      delegator: { kind: 'agent', agentId: 'external-child' },
      requesterAgentId: 'external-child',
      profileName: 'coder',
      message: 'nested',
      name: 'nested_child',
      runtime: runtimeLease.runtime,
      workDir: '/workspace',
      signal: new AbortController().signal,
    });
    await nestedRun.started;
    runtimeLease.dispose();
    const approval = approvals.request({
      id: 'approval-grandchild',
      agentId: 'grandchild',
      turnId: 1,
      toolName: 'bash',
      action: 'run',
      display: { kind: 'command', command: 'pwd' },
    });

    expect(await service.interactions({ authority })).toMatchObject({
      items: [{
        interactionId: 'approval-grandchild',
        kind: 'approval',
        taskName: 'root_child',
      }],
    });
    await service.respond({
      authority,
      interactionId: 'approval-grandchild',
      kind: 'approval',
      response: { decision: 'approved' },
    });
    await expect(approval).resolves.toEqual({ decision: 'approved' });
    completions[1]!.resolve({ summary: 'nested done' });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: rootDispatch.dispatchId })).status).toBe('completed');
    });
  });

  it('caps a yolo main at the default manual external permission ceiling', async () => {
    permissionModes.set('main', 'yolo');
    const service = ix.get(ISessionExternalDelegationService);
    await service.dispatch({
      authority,
      target: 'named',
      taskName: 'manual_child',
      profileName: 'coder',
      message: 'inspect',
    });

    expect(permissionModes.get('external-child')).toBe('manual');
    completions[0]!.resolve({ summary: 'done' });
  });

  it('honors the configured external permission ceiling', async () => {
    bootstrapEnv['KIKI_EXTERNAL_PERMISSION_CEILING'] = 'auto';
    permissionModes.set('main', 'yolo');
    const service = ix.get(ISessionExternalDelegationService);
    await service.dispatch({
      authority,
      target: 'named',
      taskName: 'auto_child',
      profileName: 'coder',
      message: 'inspect',
    });

    expect(permissionModes.get('external-child')).toBe('auto');
    completions[0]!.resolve({ summary: 'done' });
  });

  it('filters owned interactions, responds to approval and question, and preserves GUI coverage', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const interaction = ix.get(ISessionInteractionService);
    const approvals = ix.get(ISessionApprovalService);
    const questions = ix.get(ISessionQuestionService);
    interaction.acquireConsumer('gui');
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'interaction_child',
      profileName: 'coder',
      message: 'inspect',
    });
    const childApproval = approvals.request({
      id: 'approval-owned',
      agentId: 'external-child',
      turnId: 1,
      toolName: 'bash',
      action: 'run',
      display: { kind: 'command', command: 'pwd' },
    });
    const childQuestion = questions.request({
      id: 'question-owned',
      turnId: 1,
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    }, { agentId: 'external-child' });
    const mainApproval = approvals.request({
      id: 'approval-main',
      agentId: 'main',
      turnId: 1,
      toolName: 'bash',
      action: 'run',
      display: { kind: 'command', command: 'pwd' },
    });

    expect(await service.interactions({ authority })).toMatchObject({
      items: [
        { interactionId: 'approval-owned', kind: 'approval', taskName: 'interaction_child' },
        { interactionId: 'question-owned', kind: 'question', taskName: 'interaction_child' },
      ],
    });
    await expect(service.respond({
      authority,
      interactionId: 'approval-main',
      kind: 'approval',
      response: { decision: 'approved' },
    })).rejects.toMatchObject({
      code: EXTERNAL_INTERACTION_NOT_OWNED_CODE,
      details: { failure_code: EXTERNAL_INTERACTION_NOT_OWNED_CODE },
    });
    await expect(service.respond({
      authority,
      interactionId: 'approval-owned',
      kind: 'question',
      response: { decision: 'approved' },
    })).rejects.toThrow(/kind does not match/);
    await expect(service.respond({
      authority,
      interactionId: 'approval-owned',
      kind: 'approval',
      response: { answers: { 'Continue?': 'Yes' } },
    } as never)).rejects.toThrow(/invalid for an approval/);
    expect(interaction.listPending('approval').map((entry) => entry.id)).toEqual([
      'approval-owned',
      'approval-main',
    ]);
    await expect(service.respond({
      authority,
      interactionId: 'approval-owned',
      kind: 'approval',
      response: { decision: 'approved' },
    })).resolves.toEqual({ interactionId: 'approval-owned', status: 'resolved' });
    await expect(service.respond({
      authority,
      interactionId: 'question-owned',
      kind: 'question',
      response: { decision: 'continue' },
    })).resolves.toEqual({ interactionId: 'question-owned', status: 'resolved' });
    await expect(childApproval).resolves.toEqual({ decision: 'approved' });
    await expect(childQuestion).resolves.toEqual({ decision: 'continue' });

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
    expect(interaction.listPending('approval').map((entry) => entry.id)).toEqual(['approval-main']);
    interaction.releaseConsumer('gui');
    await expect(mainApproval).resolves.toEqual({ decision: 'cancelled' });
  });

  it('runs an external-executor named child and round-trips its permission through the external root', async () => {
    const fakeExecutorProfile: AgentProfile = {
      ...profile,
      name: 'external-harness',
      executor: 'fake-executor',
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: [fakeExecutorProfile.name],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === fakeExecutorProfile.name ? fakeExecutorProfile : undefined,
      getDefault: () => profile,
      list: () => [fakeExecutorProfile],
    });
    const service = ix.get(ISessionExternalDelegationService);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'external_harness_child',
      profileName: fakeExecutorProfile.name,
      message: 'inspect',
    });

    expect(dispatch).toMatchObject({
      status: 'queued',
      taskName: 'external_harness_child',
      profileName: fakeExecutorProfile.name,
    });
    expect(createdWith[0]).toMatchObject({
      binding: { resolvedProfile: { executor: 'fake-executor' } },
    });
    await vi.waitFor(async () => {
      expect(await service.interactions({ authority })).toMatchObject({
        items: [{
          interactionId: 'fake-executor-permission-external-child',
          kind: 'approval',
          taskName: 'external_harness_child',
          payload: { display: { kind: 'external_permission' } },
        }],
      });
    });

    await expect(service.respond({
      authority,
      interactionId: 'fake-executor-permission-external-child',
      kind: 'approval',
      response: { decision: 'approved', selectedOptionId: 'allow-once' },
    })).resolves.toEqual({
      interactionId: 'fake-executor-permission-external-child',
      status: 'resolved',
    });
    await vi.waitFor(() => {
      expect(fakeExecutorApprovalResponses).toEqual([
        { decision: 'approved', selectedOptionId: 'allow-once' },
      ]);
      expect(completions).toHaveLength(1);
    });

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
  });

  it('projects latest child status and usage from the dispatch ledger', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'status_child',
      profileName: 'coder',
      message: 'inspect',
    });

    expect((await service.list(authority)).children).toContainEqual({
      taskName: 'status_child',
      profileName: 'coder',
      latestDispatchId: dispatch.dispatchId,
      status: expect.stringMatching(/queued|running/),
      usage: undefined,
    });
    expect(agentMetas['external-child']?.labels?.[COLLABORATION_LATEST_TASK_LABEL]).toBe(
      dispatch.dispatchId,
    );

    completions[0]!.resolve({
      summary: 'done',
      usage: {
        inputOther: 11,
        output: 7,
        inputCacheRead: 5,
        inputCacheCreation: 3,
      },
    });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    expect((await service.list(authority)).children).toContainEqual({
      taskName: 'status_child',
      profileName: 'coder',
      latestDispatchId: dispatch.dispatchId,
      status: 'completed',
      usage: { input: 19, output: 7, cacheRead: 5, cacheWrite: 3 },
    });
  });

  it('reads transcript and events while a named dispatch is running', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'running_reader',
      profileName: 'coder',
      message: 'work',
    });
    const child = handles.get('external-child')!;
    vi.spyOn(child.accessor.get(IAgentExecutionService), 'status').mockReturnValue({
      state: 'running',
      turnId: 1,
    });

    await expect(
      service.transcript({ authority, dispatchId: dispatch.dispatchId }),
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    const events = await service.events({ authority, dispatchId: dispatch.dispatchId });
    expect(events.items.map((event) => event.type)).toContain('queued');
  });

  it('uses one durable cursor for live updates, rebuilds, and item watermarks', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const records = wireRecords.get('main')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'hello ' },
        },
      },
    );

    const first = await service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
      limit: 1,
    });
    expect(first).toMatchObject({
      items: [{ kind: 'turn', turnId: 't1', steps: [{ frames: [{ text: 'hello ' }] }] }],
      cursor: expect.any(Number),
    });
    expect(first.cursor).toBeGreaterThan(0);

    records.push(
      {
        type: 'context.append_loop_event',
        time: 4,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'world' },
        },
      },
      {
        type: 'context.append_loop_event',
        time: 5,
        event: {
          type: 'tool.call',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          toolCallId: 'tool-1',
          name: 'Read',
          args: { path: 'a.ts' },
        },
      },
      {
        type: 'tool.progress',
        time: 6,
        turnId: 1,
        toolCallId: 'tool-1',
        update: { kind: 'status', text: 'reading' },
      },
      {
        type: 'context.append_loop_event',
        time: 7,
        event: {
          type: 'step.end',
          uuid: 's1',
          turnId: '1',
          step: 1,
          usage: { inputOther: 10, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
        },
      },
    );

    const second = await service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
      cursor: first.cursor,
      limit: 1,
    });
    expect(second).toMatchObject({
      items: [{
        kind: 'turn',
        turnId: 't1',
        steps: [{
          frames: [
            { kind: 'text', text: 'hello world' },
            { kind: 'tool', toolCallId: 'tool-1', progress: { text: 'reading' } },
          ],
        }],
      }],
      cursor: expect.any(Number),
    });
    expect(second.cursor).toBeGreaterThan(first.cursor);
    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
      cursor: second.cursor,
      limit: 1,
    })).resolves.toEqual({ items: [], cursor: second.cursor, nextCursor: undefined });

    const turnEvents = await service.events({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'turn',
    });
    expect(turnEvents.items.map((item) => item.event.type)).toEqual([
      'message.delta',
      'message.delta',
      'tool.call',
      'tool.update',
      'usage',
    ]);
    const repeated = await service.events({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'turn',
    });
    expect(repeated.items).toEqual(turnEvents.items);
  });

  it('isolates concurrent journal rebuild readers', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    wireRecords.get('main')!.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'answer' },
        },
      },
    );
    journalYield = async () => { await Promise.resolve(); };

    const [eventsA, itemsA, eventsB, itemsB] = await Promise.all([
      service.events({ authority, dispatchId: dispatch.dispatchId, detail: 'turn' }),
      service.transcript({ authority, dispatchId: dispatch.dispatchId, detail: 'items' }),
      service.events({ authority, dispatchId: dispatch.dispatchId, detail: 'turn' }),
      service.transcript({ authority, dispatchId: dispatch.dispatchId, detail: 'items' }),
    ]);
    expect(eventsA).toEqual(eventsB);
    expect(itemsA).toEqual(itemsB);
    expect(eventsA.items.map((item) => item.event.type)).toEqual(['message.delta']);
    expect(itemsA).toMatchObject({ items: [{ kind: 'turn', turnId: 't1' }] });
    await service.events({ authority, dispatchId: dispatch.dispatchId, detail: 'turn' });
    await service.transcript({ authority, dispatchId: dispatch.dispatchId, detail: 'items' });
    expect(journalReads.get('main')).toBe(2);
  });

  it('rebuilds terminal bounds instead of sharing an older generation', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const records = wireRecords.get('main')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'answer' },
        },
      },
    );
    let releaseRebuild!: () => void;
    const rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    let markRebuildStarted!: () => void;
    const rebuildStarted = new Promise<void>((resolve) => { markRebuildStarted = resolve; });
    let blocked = false;
    journalYield = async () => {
      if (blocked) return;
      blocked = true;
      markRebuildStarted();
      await rebuildGate;
    };

    const staleReader = service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
    });
    await rebuildStarted;
    records.push({ type: 'turn.ended', time: 4, turnId: 1, reason: 'completed' });
    completions[0]!.resolve({ summary: 'done' });
    const terminalReader = service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
    });
    await vi.waitFor(() => {
      expect(journalReads.get('main')).toBe(3);
    });
    releaseRebuild();

    await expect(terminalReader).resolves.toMatchObject({
      items: [{ kind: 'turn', turnId: 't1', state: 'completed' }],
    });
    await expect(staleReader).resolves.toMatchObject({
      items: [{ kind: 'turn', turnId: 't1', state: 'completed' }],
    });
    expect(journalReads.get('main')).toBe(3);
  });

  it('freezes each dispatch slice across later runs and journal rebuilds', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const first = await service.dispatch({ authority, target: 'main', message: 'first' });
    const records = wireRecords.get('main')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'first' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'first result' },
        },
      },
      { type: 'turn.ended', time: 4, turnId: 1, reason: 'completed' },
    );
    completions[0]!.resolve({ summary: 'first done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: first.dispatchId })).status).toBe('completed');
    });

    const second = await service.continue({
      authority,
      dispatchId: first.dispatchId,
      message: 'second',
    });
    records.push(
      {
        type: 'turn.prompt',
        time: 5,
        turnId: 2,
        input: [{ type: 'text', text: 'second' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 6,
        event: { type: 'step.begin', uuid: 's2', turnId: '2', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 7,
        event: {
          type: 'content.part',
          stepUuid: 's2',
          turnId: '2',
          step: 1,
          uuid: 'm2',
          part: { type: 'text', text: 'second result' },
        },
      },
      { type: 'turn.ended', time: 8, turnId: 2, reason: 'completed' },
    );
    completions[1]!.resolve({ summary: 'second done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: second.dispatchId })).status).toBe('completed');
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const page = await service.transcript({
        authority,
        dispatchId: first.dispatchId,
        detail: 'items',
      });
      expect(page.items).toMatchObject([{ kind: 'turn', turnId: 't1' }]);
      expect(page.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ turnId: 't2' })]));
      const events = await service.events({
        authority,
        dispatchId: first.dispatchId,
        detail: 'turn',
      });
      expect(JSON.stringify(events)).not.toContain('second result');
    }
  });

  it('migrates transcriptStart to transcript seq while preserving text paging', async () => {
    const main = handles.get('main')!;
    const messages: ContextMessage[] = [{
      role: 'user',
      content: [{ type: 'text' as const, text: 'before' }],
      toolCalls: [],
    }];
    vi.spyOn(main.accessor.get(IAgentContextMemoryService), 'get').mockImplementation(() => messages as never);
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    messages.push({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'after' }],
      toolCalls: [],
    });

    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'text',
    })).resolves.toEqual({
      items: [{ index: 1, role: 'assistant', text: 'after' }],
      nextCursor: undefined,
    });
    const stored = documents.get('root') as {
      dispatches: Record<string, {
        transcriptStart: number;
        transcriptCursorVersion: number;
        legacyTranscriptStart: number;
      }>;
    };
    expect(stored.dispatches[dispatch.dispatchId]).toMatchObject({
      transcriptStart: 0,
      transcriptCursorVersion: 2,
      legacyTranscriptStart: 1,
    });
  });

  it('freezes text and structured bounds before a later turn during rebuild', async () => {
    const main = handles.get('main')!;
    const messages: ContextMessage[] = [{
      role: 'user',
      content: [{ type: 'text' as const, text: 'before' }],
      toolCalls: [],
    }];
    vi.spyOn(main.accessor.get(IAgentContextMemoryService), 'get').mockImplementation(() => messages as never);
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const records = wireRecords.get('main')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'owned result' },
        },
      },
      { type: 'turn.ended', time: 4, turnId: 1, reason: 'completed' },
    );
    messages.push({
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'owned result' }],
      toolCalls: [],
    });
    let releaseRebuild!: () => void;
    const rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    let markRebuildStarted!: () => void;
    const rebuildStarted = new Promise<void>((resolve) => { markRebuildStarted = resolve; });
    let blocked = false;
    journalYield = async () => {
      if (blocked) return;
      blocked = true;
      markRebuildStarted();
      await rebuildGate;
    };

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
    await rebuildStarted;
    messages.push({
      role: 'user',
      content: [{ type: 'text' as const, text: 'later private turn' }],
      toolCalls: [],
    });
    records.push(
      {
        type: 'turn.prompt',
        time: 5,
        turnId: 2,
        input: [{ type: 'text', text: 'later private turn' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 6,
        event: { type: 'step.begin', uuid: 's2', turnId: '2', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 7,
        event: {
          type: 'content.part',
          stepUuid: 's2',
          turnId: '2',
          step: 1,
          uuid: 'm2',
          part: { type: 'text', text: 'private result' },
        },
      },
      { type: 'turn.ended', time: 8, turnId: 2, reason: 'completed' },
    );
    releaseRebuild();

    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'text',
    })).resolves.toEqual({
      items: [{ index: 1, role: 'assistant', text: 'owned result' }],
      nextCursor: undefined,
    });
    const structured = await service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
    });
    expect(structured.items).toMatchObject([{ kind: 'turn', turnId: 't1' }]);
    expect(structured.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 't2' }),
    ]));
    const stored = documents.get('root') as {
      dispatches: Record<string, { legacyTranscriptEnd: number }>;
    };
    expect(stored.dispatches[dispatch.dispatchId]!.legacyTranscriptEnd).toBe(2);
  });

  it('migrates a legacy terminal slice with strict repeated timestamp bounds', async () => {
    wireRecords.set('main', [
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'private before' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '1',
          step: 1,
          uuid: 'm1',
          part: { type: 'text', text: 'private answer' },
        },
      },
      { type: 'turn.ended', time: 4, turnId: 1, reason: 'completed' },
      {
        type: 'turn.prompt',
        time: 10,
        turnId: 2,
        input: [{ type: 'text', text: 'delegated work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 11,
        event: { type: 'step.begin', uuid: 's2', turnId: '2', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 12,
        event: {
          type: 'content.part',
          stepUuid: 's2',
          turnId: '2',
          step: 1,
          uuid: 'm2',
          part: { type: 'text', text: 'delegated answer' },
        },
      },
      {
        type: 'context.append_loop_event',
        time: 12,
        event: {
          type: 'content.part',
          stepUuid: 's2',
          turnId: '2',
          step: 1,
          uuid: 'm2',
          part: { type: 'text', text: ' repeated' },
        },
      },
      { type: 'turn.ended', time: 13, turnId: 2, reason: 'completed' },
      {
        type: 'turn.prompt',
        time: 14,
        turnId: 3,
        input: [{ type: 'text', text: 'private after' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 14,
        event: { type: 'step.begin', uuid: 's3', turnId: '3', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 14,
        event: {
          type: 'content.part',
          stepUuid: 's3',
          turnId: '3',
          step: 1,
          uuid: 'm3',
          part: { type: 'text', text: 'private result' },
        },
      },
    ]);
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_legacy',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_legacy: {
          dispatchId: 'dispatch_legacy',
          target: 'main',
          agentId: 'main',
          status: 'completed',
          createdAt: 9,
          endedAt: 14,
          transcriptStart: 1,
        },
      },
      events: [],
      nextEventSeq: 1,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const page = await service.transcript({
      authority,
      dispatchId: 'dispatch_legacy',
      detail: 'items',
    });
    expect(page.items).toMatchObject([{
      kind: 'turn',
      turnId: 't2',
      steps: [{ frames: [{ kind: 'text', text: 'delegated answer repeated' }] }],
    }]);
    expect(page.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 't1' }),
      expect.objectContaining({ turnId: 't3' }),
    ]));
  });

  it('keeps a legacy owned turn whose first record matches createdAt', async () => {
    wireRecords.set('main', [
      {
        type: 'turn.prompt',
        time: 8,
        turnId: 1,
        input: [{ type: 'text', text: 'private before' }],
        origin: { kind: 'user' },
      },
      { type: 'turn.ended', time: 9, turnId: 1, reason: 'completed' },
      {
        type: 'turn.prompt',
        time: 9,
        turnId: 2,
        input: [{ type: 'text', text: 'delegated work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 10,
        event: { type: 'step.begin', uuid: 's2', turnId: '2', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 11,
        event: {
          type: 'content.part',
          stepUuid: 's2',
          turnId: '2',
          step: 1,
          uuid: 'm2',
          part: { type: 'text', text: 'delegated answer' },
        },
      },
      { type: 'turn.ended', time: 12, turnId: 2, reason: 'completed' },
    ]);
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_legacy_start',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_legacy_start: {
          dispatchId: 'dispatch_legacy_start',
          target: 'main',
          agentId: 'main',
          status: 'completed',
          createdAt: 9,
          endedAt: 13,
          transcriptStart: 0,
        },
      },
      events: [],
      nextEventSeq: 1,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const page = await service.transcript({
      authority,
      dispatchId: 'dispatch_legacy_start',
      detail: 'items',
    });
    expect(page.items).toMatchObject([{ kind: 'turn', turnId: 't2' }]);
    expect(page.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 't1' }),
    ]));
  });

  it('rebuilds items and turn events from the durable agent journal', async () => {
    wireRecords.set('main', [
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 3,
        input: [{ type: 'text', text: 'persisted prompt' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's3', turnId: '3', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 3,
        event: {
          type: 'content.part',
          stepUuid: 's3',
          turnId: '3',
          step: 1,
          uuid: 'm3',
          part: { type: 'text', text: 'persisted answer' },
        },
      },
      {
        type: 'context.append_loop_event',
        time: 4,
        event: {
          type: 'tool.call',
          stepUuid: 's3',
          turnId: '3',
          step: 1,
          toolCallId: 'persisted-tool',
          name: 'Read',
          args: { path: 'persisted.ts' },
        },
      },
      {
        type: 'context.append_loop_event',
        time: 5,
        event: {
          type: 'tool.result',
          toolCallId: 'persisted-tool',
          result: { output: 'persisted result' },
        },
      },
      {
        type: 'context.append_loop_event',
        time: 6,
        event: { type: 'step.end', uuid: 's3', turnId: '3', step: 1 },
      },
      { type: 'turn.ended', time: 7, turnId: 3, reason: 'completed' },
      {
        type: 'turn.prompt',
        time: 8,
        turnId: 4,
        input: [{ type: 'text', text: 'later prompt' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 9,
        event: { type: 'step.begin', uuid: 's4', turnId: '4', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        time: 10,
        event: {
          type: 'content.part',
          stepUuid: 's4',
          turnId: '4',
          step: 1,
          uuid: 'm4',
          part: { type: 'text', text: 'later answer' },
        },
      },
    ]);
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_durable',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_durable: {
          dispatchId: 'dispatch_durable',
          target: 'main',
          agentId: 'main',
          status: 'completed',
          createdAt: 1,
          endedAt: 8,
          transcriptStart: 0,
          transcriptCursorVersion: 2,
          legacyTranscriptStart: 0,
        },
      },
      events: [],
      nextEventSeq: 1,
    });
    const service = ix.get(ISessionExternalDelegationService);

    await expect(service.transcript({
      authority,
      dispatchId: 'dispatch_durable',
      detail: 'items',
    })).resolves.toMatchObject({
      items: [{
        kind: 'turn',
        turnId: 't3',
        state: 'completed',
        prompt: 'persisted prompt',
        steps: [{
          frames: [
            { kind: 'text', text: 'persisted answer' },
            { kind: 'tool', toolCallId: 'persisted-tool', output: 'persisted result' },
          ],
        }],
      }],
    });
    expect((await service.transcript({
      authority,
      dispatchId: 'dispatch_durable',
      detail: 'items',
    })).items.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual(['t3']);
    expect((await service.events({
      authority,
      dispatchId: 'dispatch_durable',
      detail: 'turn',
    })).items.map((item) => item.event.type)).toEqual([
      'message.delta',
      'tool.call',
      'tool.update',
    ]);
  });

  it('signals lifecycle ring truncation without reusing event seq', async () => {
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_ring',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_ring: {
          dispatchId: 'dispatch_ring',
          target: 'main',
          agentId: 'main',
          status: 'running',
          createdAt: 1,
          startedAt: 2,
          transcriptStart: 0,
        },
      },
      events: Array.from({ length: 5_000 }, (_, index) => ({
        seq: index + 1,
        dispatchId: 'dispatch_ring',
        type: index === 0 ? 'queued' : 'started',
        at: index + 1,
      })),
      nextEventSeq: 5_001,
    });
    const service = ix.get(ISessionExternalDelegationService);

    expect((await service.status({ authority, dispatchId: 'dispatch_ring' })).status).toBe('interrupted');
    const page = await service.events({ authority, dispatchId: 'dispatch_ring', cursor: 0, limit: 1 });
    expect(page).toMatchObject({
      items: [{ seq: 2 }],
      nextCursor: 2,
      truncated_before_seq: 2,
    });
    expect((await service.events({
      authority,
      dispatchId: 'dispatch_ring',
      cursor: 5_000,
    })).items).toEqual([
      expect.objectContaining({ seq: 5_001, type: 'interrupted' }),
    ]);
  });

  it('rejects dispatch while the target loop has a queued prompt', async () => {
    const main = handles.get('main')!;
    vi.spyOn(main.accessor.get(IAgentLoopService), 'status').mockReturnValue({
      state: 'idle',
      pendingTurnIds: [1],
      hasPendingRequests: false,
    });
    const service = ix.get(ISessionExternalDelegationService);

    await expect(
      service.dispatch({ authority, target: 'main', message: 'work' }),
    ).rejects.toThrow(/already running/);
    expect(runAgentIds).toEqual([]);
  });

  it('binds profiles that reference user tools inherited from the main agent', async () => {
    const lookupTool = {
      name: 'ExternalLookup',
      description: 'Look up an externally delegated value.',
      parameters: {},
    };
    const inheritedProfile: AgentProfile = {
      ...profile,
      disallowedTools: [lookupTool.name],
    };
    const mainUserTools = handles.get('main')!.accessor.get(IAgentUserToolService);
    vi.spyOn(mainUserTools, 'list').mockReturnValue([lookupTool]);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === inheritedProfile.name ? inheritedProfile : undefined,
      getDefault: () => inheritedProfile,
      list: () => [inheritedProfile],
    });
    const service = ix.get(ISessionExternalDelegationService);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'user_tool_child',
      profileName: inheritedProfile.name,
      message: 'look up',
    });

    expect(dispatch.status).toBe('queued');
    expect(createdWith[0]).toMatchObject({
      binding: {
        resolvedProfile: inheritedProfile,
        inheritedUserToolNames: [lookupTool.name],
      },
    });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
  });

  it('binds an exact model and effort only when creating a named child', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const first = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'exact_binding',
      profileName: 'coder',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
      message: 'inspect',
    });

    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'coder',
        model: 'grok-4.6',
        thinking: 'high',
        strictThinking: true,
      },
      delegator: { kind: 'external' },
    });
    expect(first).toMatchObject({
      target: 'named',
      taskName: 'exact_binding',
      profileName: 'coder',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
    });
    expect(runAgentIds).toEqual(['external-child']);
    expect(runAgentIds).not.toContain('main');

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: first.dispatchId })).status).toBe('completed');
    });

    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'exact_binding',
        modelAlias: 'other-model',
        message: 'switch',
      }),
    ).rejects.toThrow(/cannot change model_alias/);
    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'exact_binding',
        thinkingEffort: 'low',
        message: 'switch',
      }),
    ).rejects.toThrow(/cannot change thinking_effort/);

    const repeated = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'exact_binding',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
      message: 'same binding',
    });
    expect(repeated).toMatchObject({ modelAlias: 'grok-4.6', thinkingEffort: 'high' });
    expect(createdWith).toHaveLength(1);
  });

  it('keeps profile-pinned thinking strict for a newly created named child', async () => {
    const pinnedProfile: AgentProfile = {
      ...profile,
      thinkingEffort: 'high',
    };
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === pinnedProfile.name ? pinnedProfile : undefined,
      getDefault: () => pinnedProfile,
      list: () => [pinnedProfile],
    });
    const service = ix.get(ISessionExternalDelegationService);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'strict_profile',
      profileName: pinnedProfile.name,
      message: 'inspect',
    });

    expect(createdWith[0]).toMatchObject({
      binding: {
        thinking: 'high',
        strictThinking: true,
      },
    });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });
  });

  it('fails closed when a named child has no model pin or dispatch model', async () => {
    const unboundProfile: AgentProfile = {
      ...profile,
      name: 'unbound',
      modelAlias: undefined,
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'main-model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['unbound'],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === unboundProfile.name ? unboundProfile : undefined,
      getDefault: () => profile,
      list: () => [unboundProfile],
    });
    const service = ix.get(ISessionExternalDelegationService);

    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'unbound',
        profileName: 'unbound',
        message: 'inspect',
      }),
    ).rejects.toThrow(/No model is bound/);
    expect(createdWith).toHaveLength(0);
  });

  it('binds a scoped named child from the main profile snapshot', async () => {
    const publicWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'public-writer',
      description: 'Public writer',
      systemPrompt: () => 'PUBLIC',
      renderSystemPrompt: () => ({ text: 'PUBLIC', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PUBLIC PREFIX',
    };
    const scopedWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'private-writer',
      description: 'Private writer',
      modelAlias: 'model',
      systemPrompt: () => 'PRIVATE',
      renderSystemPrompt: () => ({ text: 'PRIVATE', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PRIVATE PREFIX',
    };
    const snapshot = {
      publicProfiles: new Map([['writer', publicWriter]]),
      defaultProfile: profile,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'writer',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'writer',
                source: './_private/writer.md',
                lease: { name: 'writer', source: './_private/writer.md' },
                status: 'ready' as const,
                sourceDefinitionId: 'private-writer',
                profile: scopedWriter,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map([['private-writer', scopedWriter]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      profileDefinitionId: 'parent-definition',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['writer'],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      getDefault: () => profile,
      list: () => [...snapshot.publicProfiles.values()],
      snapshot: () => snapshot,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_writer',
      profileName: 'writer',
      message: 'write',
    });

    expect(root.dispatchables).toContainEqual(
      expect.objectContaining({
        kind: 'named',
        profileName: 'writer',
        description: 'Private writer',
      }),
    );
    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'writer',
        resolvedProfile: scopedWriter,
      },
    });
    expect(dispatch.profileName).toBe('writer');
    await vi.waitFor(() => {
      expect(runPrompts).toEqual(['PRIVATE PREFIX\n\nwrite']);
    });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_writer',
      message: 'write again',
    });

    await vi.waitFor(() => {
      expect(runPrompts).toEqual([
        'PRIVATE PREFIX\n\nwrite',
        'write again',
      ]);
    });
  });

  it('starts a scoped named child without a same-name public profile', async () => {
    const scopedWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'private-only-writer',
      description: 'Private-only writer',
      modelAlias: 'model',
      systemPrompt: () => 'PRIVATE ONLY',
      renderSystemPrompt: () => ({ text: 'PRIVATE ONLY', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PRIVATE ONLY PREFIX',
    };
    const snapshot = {
      publicProfiles: new Map([['coder', profile]]),
      defaultProfile: profile,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'writer',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'writer',
                source: './_private/writer.md',
                lease: { name: 'writer', source: './_private/writer.md' },
                status: 'ready' as const,
                sourceDefinitionId: 'private-only-writer',
                profile: scopedWriter,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map([['private-only-writer', scopedWriter]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      profileDefinitionId: 'parent-definition',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['writer'],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      getDefault: () => profile,
      list: () => [...snapshot.publicProfiles.values()],
      snapshot: () => snapshot,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_only_writer',
      profileName: 'writer',
      message: 'write',
    });

    expect(dispatch.status).toBe('queued');
    await vi.waitFor(() => {
      expect(runPrompts).toEqual(['PRIVATE ONLY PREFIX\n\nwrite']);
    });
  });

  it('rejects named-child binding fields for a main dispatch', async () => {
    const service = ix.get(ISessionExternalDelegationService);

    await expect(
      service.dispatch({
        authority,
        target: 'main',
        modelAlias: 'grok-4.6',
        message: 'work',
      }),
    ).rejects.toThrow(/not admitted for target main/);
    expect(runAgentIds).toEqual([]);
  });

  it('projects the complete structured profile catalog for dispatch seats', async () => {
    const richProfile: AgentProfile = {
      ...profile,
      description: 'Review implementation',
      whenToUse: 'Use for focused code review.',
      thinkingEffort: 'high',
      allowedModels: ['model', 'alternate-model'],
      modelProfiles: [
        {
          alias: 'alternate-model',
          when: 'Use for a second opinion.',
          thinkingEffort: 'medium',
        },
      ],
      tools: ['Read', 'Write'],
    };
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === richProfile.name ? richProfile : undefined,
      getDefault: () => richProfile,
      list: () => [richProfile],
    });
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);

    expect(root.dispatchables).toContainEqual({
      kind: 'named',
      profileName: 'coder',
      description: 'Review implementation',
      whenToUse: 'Use for focused code review.',
      modelAlias: 'model',
      thinkingEffort: 'high',
      allowedModels: ['model', 'alternate-model'],
      alternativeModels: [
        {
          alias: 'alternate-model',
          when: 'Use for a second opinion.',
          thinkingEffort: 'medium',
        },
      ],
      tools: 'Read, Write',
    });
  });

  it('uses the same effective target list and lease as in-process delegation', async () => {
    const mainProfile: AgentProfile = {
      name: 'agent',
      main: true,
      description: 'Main profile',
      systemPrompt: () => 'main',
      renderSystemPrompt: () => ({ text: 'main', environment: { cwd: '', date: { disclosed: false } } }),
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['agent', 'coder'],
      subagentLeases: {
        coder: {
          name: 'coder',
          description: 'Leased code owner',
          modelAlias: 'leased-model',
        },
      },
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : name === mainProfile.name ? mainProfile : undefined,
      getDefault: () => mainProfile,
      list: () => [mainProfile, profile],
    } as unknown as ISessionAgentProfileCatalog);
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);
    expect(root.dispatchables).toMatchObject([
      { kind: 'main' },
      {
        kind: 'named',
        profileName: 'coder',
        description: 'Leased code owner',
        modelAlias: 'leased-model',
      },
    ]);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'leased_coder',
      profileName: 'coder',
      message: 'work',
    });

    expect(dispatch.modelAlias).toBe('leased-model');
    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'coder',
        model: 'leased-model',
        lease: {
          name: 'coder',
          description: 'Leased code owner',
          modelAlias: 'leased-model',
        },
      },
    });
  });

  it('keeps the external contract profile-only instead of advertising an unselectable route', async () => {
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : undefined,
      getDefault: () => profile,
      list: () => [profile],
      listRoutes: () => [{
        id: 'coder.review',
        profile: 'coder',
        description: 'Review route',
        overriddenFields: ['tools'],
      }],
    } as unknown as ISessionAgentProfileCatalog);
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);

    expect(root.dispatchables).toMatchObject([
      { kind: 'main' },
      { kind: 'named', profileName: 'coder', description: 'Code owner' },
    ]);
    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'routed',
        profileName: 'coder.review',
        message: 'review',
      }),
    ).rejects.toThrow('Unknown named-agent profile');
    expect(createdWith).toEqual([]);
  });

  it('rejects another principal and unknown dispatch handles', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    await service.list(authority);
    await expect(service.list({ ...authority, principalFingerprint: 'd'.repeat(64) })).rejects.toThrow(/does not own/);
    await expect(service.status({ authority, dispatchId: 'dispatch_unknown' })).rejects.toThrow(/Unknown external dispatch/);
  });

  it('marks a persisted nonterminal dispatch interrupted instead of claiming it resumed', async () => {
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_cold',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_cold: {
          dispatchId: 'dispatch_cold',
          target: 'main',
          agentId: 'main',
          status: 'running',
          createdAt: 1,
          startedAt: 2,
          transcriptStart: 0,
        },
      },
      events: [],
      nextEventSeq: 1,
    });

    const service = ix.get(ISessionExternalDelegationService);
    expect((await service.status({ authority, dispatchId: 'dispatch_cold' })).status).toBe('interrupted');
  });

  it('cancels idempotently without cancelling sibling work', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
  });

  it('claims cancellation once and seals after aborted execution records settle', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const records = wireRecords.get('main')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
    );
    onRunAbort = () => {
      records.push(
        {
          type: 'context.append_loop_event',
          time: 3,
          event: {
            type: 'content.part',
            stepUuid: 's1',
            turnId: '1',
            step: 1,
            uuid: 'm1',
            part: { type: 'text', text: 'interrupted partial' },
          },
        },
        { type: 'turn.ended', time: 4, turnId: 1, reason: 'cancelled' },
      );
    };
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('running');
    });

    const [first, second] = await Promise.all([
      service.cancel({ authority, dispatchId: dispatch.dispatchId }),
      service.cancel({ authority, dispatchId: dispatch.dispatchId }),
    ]);
    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('cancelled');
    const lifecycle = await service.events({ authority, dispatchId: dispatch.dispatchId });
    expect(lifecycle.items.map((event) => event.type)).toEqual(['queued', 'started', 'cancelled']);
    expect(lifecycle.items.filter((event) => event.type === 'cancelled')).toHaveLength(1);
    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
    })).resolves.toMatchObject({
      items: [{
        kind: 'turn',
        turnId: 't1',
        state: 'cancelled',
        steps: [{ frames: [{ kind: 'text', text: 'interrupted partial' }] }],
      }],
    });
  });

  it('freezes cancelled text before later private messages during terminalization', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'cancel_text',
      profileName: 'coder',
      message: 'work',
    });
    const child = handles.get('external-child')!;
    const messages: ContextMessage[] = [];
    vi.spyOn(child.accessor.get(IAgentContextMemoryService), 'get').mockImplementation(() => messages as never);
    const records = wireRecords.get('external-child')!;
    records.push(
      {
        type: 'turn.prompt',
        time: 1,
        turnId: 1,
        input: [{ type: 'text', text: 'work' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        time: 2,
        event: { type: 'step.begin', uuid: 's1', turnId: '1', step: 1 },
      },
    );
    onRunAbort = () => {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'interrupted partial' }],
        toolCalls: [],
      });
      records.push(
        {
          type: 'context.append_loop_event',
          time: 3,
          event: {
            type: 'content.part',
            stepUuid: 's1',
            turnId: '1',
            step: 1,
            uuid: 'm1',
            part: { type: 'text', text: 'interrupted partial' },
          },
        },
        { type: 'turn.ended', time: 4, turnId: 1, reason: 'cancelled' },
      );
    };
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('running');
    });
    const dispatchService = ix.get(ISessionDispatchService);
    const resolveOwnedChild = dispatchService.resolveOwnedChild.bind(dispatchService);
    let releaseMaterialization!: () => void;
    const materializationGate = new Promise<void>((resolve) => { releaseMaterialization = resolve; });
    let markMaterializationStarted!: () => void;
    const materializationStarted = new Promise<void>((resolve) => { markMaterializationStarted = resolve; });
    let blocked = false;
    vi.spyOn(dispatchService, 'resolveOwnedChild').mockImplementation(async (delegator, ref) => {
      if (!blocked) {
        blocked = true;
        markMaterializationStarted();
        await materializationGate;
      }
      return resolveOwnedChild(delegator, ref);
    });

    await expect(service.cancel({ authority, dispatchId: dispatch.dispatchId })).resolves.toMatchObject({
      status: 'cancelled',
    });
    await materializationStarted;
    messages.push({
      role: 'user',
      content: [{ type: 'text' as const, text: 'later private message' }],
      toolCalls: [],
    });
    releaseMaterialization();

    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'text',
    })).resolves.toEqual({
      items: [{ index: 0, role: 'assistant', text: 'interrupted partial' }],
      nextCursor: undefined,
    });
    const stored = documents.get('root') as {
      dispatches: Record<string, { legacyTranscriptEnd: number }>;
    };
    expect(stored.dispatches[dispatch.dispatchId]!.legacyTranscriptEnd).toBe(1);
  });

  it('pages results with the admitted byte limit instead of rejecting limits above the default page size', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    completions[0]!.resolve({ summary: 'é'.repeat(40_000) });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    const first = await service.result({
      authority,
      dispatchId: dispatch.dispatchId,
      limit: 65_536,
    });
    const second = await service.result({
      authority,
      dispatchId: dispatch.dispatchId,
      cursor: first.nextCursor,
      limit: 65_536,
    });

    expect(Buffer.byteLength(first.text, 'utf8')).toBe(65_536);
    expect(first.nextCursor).toBe(32_768);
    expect(Buffer.byteLength(second.text, 'utf8')).toBe(14_464);
    expect(second.nextCursor).toBeUndefined();
  });

  it('keeps UTF-8 pages on scalar boundaries and rejects undersized limits', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    completions[0]!.resolve({ summary: '😀e\u0301Z' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    for (const limit of [1, 2, 3]) {
      await expect(
        service.result({ authority, dispatchId: dispatch.dispatchId, limit }),
      ).rejects.toThrow(/limit is invalid/);
    }
    const emoji = await service.result({
      authority,
      dispatchId: dispatch.dispatchId,
      limit: 4,
    });
    expect(emoji).toMatchObject({ text: '😀', nextCursor: 2 });
    expect(Buffer.byteLength(emoji.text, 'utf8')).toBe(4);
    await expect(
      service.result({
        authority,
        dispatchId: dispatch.dispatchId,
        cursor: 1,
        limit: 4,
      }),
    ).rejects.toThrow(/cursor is invalid/);
    await expect(
      service.result({
        authority,
        dispatchId: dispatch.dispatchId,
        cursor: emoji.nextCursor,
        limit: 4,
      }),
    ).resolves.toMatchObject({ text: 'e\u0301Z', nextCursor: undefined });
  });

  it('does not publish started after cancellation wins a deferred run-handle race', async () => {
    let releaseRunHandle!: () => void;
    nextRunHandleGate = new Promise<void>((resolve) => { releaseRunHandle = resolve; });
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    expect(dispatch.status).toBe('queued');

    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect(runSignals[0]?.aborted).toBe(true);
    releaseRunHandle();
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    });
    const eventTypes = (await service.events({ authority, dispatchId: dispatch.dispatchId })).items.map((event) => event.type);
    expect(eventTypes).toEqual(['queued', 'cancelled']);

    const later = await service.dispatch({ authority, target: 'main', message: 'later work' });
    expect(later.status).toBe('queued');
    expect(later.dispatchId).not.toBe(dispatch.dispatchId);
  });

  it('persists only typed, redacted, byte-bounded external failures', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const secret = 'SEEDED_SECRET_TOKEN';
    const path = 'C:\\Users\\secret-user\\credentials.json';
    const url = 'https://provider.invalid/private?api_key=SEEDED_API_KEY';
    completions[0]!.reject(new Error(`${'failure '.repeat(300)} Bearer ${secret} at ${path} via ${url}`));

    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
    });
    const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
    const result = await service.result({ authority, dispatchId: dispatch.dispatchId });
    const events = await service.events({ authority, dispatchId: dispatch.dispatchId });
    const persisted = JSON.stringify(documents.get('root'));

    expect(status.errorCode).toBe('internal');
    expect(result.text).toBe('External agent run failed.');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(512);
    expect(events.items.at(-1)).toMatchObject({ type: 'failed', message: result.text });
    for (const projection of [persisted, JSON.stringify(result), JSON.stringify(events)]) {
      expect(projection).not.toContain(secret);
      expect(projection).not.toContain('SEEDED_API_KEY');
      expect(projection).not.toContain(path);
      expect(projection).not.toContain(url);
    }
  });

  it('classifies provider auth failures: category crosses the edge, raw text stays in the log', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const raw = '401 Unauthorized: Bearer sk-live-SEEDED at C:\\Users\\secret-user\\credentials.json';
    completions[0]!.reject(new Error2('provider.auth_error', raw));

    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
    });
    const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
    const result = await service.result({ authority, dispatchId: dispatch.dispatchId });
    const persisted = JSON.stringify(documents.get('root'));

    expect(status.errorCode).toBe('auth_expired');
    expect(result.text).toBe(
      'External agent authentication expired or was rejected; re-authenticate the provider and retry.',
    );
    expect(persisted).not.toContain('sk-live-SEEDED');
    expect(persisted).not.toContain('secret-user');
    expect(persisted).not.toContain(raw);

    const failure = logCalls.find((entry) => entry.msg === 'External dispatch failed.');
    expect(failure?.payload).toMatchObject({
      dispatchId: dispatch.dispatchId,
      sessionId: 'session_test',
      code: 'provider.auth_error',
      category: 'auth_expired',
      raw,
    });
  });

  it('classifies quota, model, network, and validation failures onto the stable taxonomy', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const cases: Array<{ code: ErrorCode; category: string }> = [
      { code: 'provider.rate_limit', category: 'quota_exceeded' },
      { code: 'model.not_found', category: 'model_not_supported' },
      { code: 'provider.connection_error', category: 'network' },
      { code: 'validation.failed', category: 'invalid_input' },
    ];
    for (const [index, { code, category }] of cases.entries()) {
      const dispatch = await service.dispatch({ authority, target: 'main', message: `work ${index}` });
      completions.at(-1)!.reject(new Error2(code, `raw detail ${code}`));
      await vi.waitFor(async () => {
        expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
      });
      const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
      expect(status.errorCode, code).toBe(category);
      const persisted = JSON.stringify(documents.get('root'));
      expect(persisted, code).not.toContain(`raw detail ${code}`);
    }
  });

  it('persists interruption before the Session close hook proceeds', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });

    const waits: Promise<unknown>[] = [];
    willClose.fire({
      sessionId: 'session_test',
      handle: {} as never,
      reason: 'exit',
      signal: new AbortController().signal,
      waitUntil: (promise) => {
        waits.push(Promise.resolve(promise));
      },
    });
    await Promise.all(waits);

    expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('interrupted');
    expect(documents.get('root')).toMatchObject({ lastCloseReason: 'exit' });
  });
});
