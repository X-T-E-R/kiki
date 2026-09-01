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
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { Event2 } from '#/app/event/event2';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  AssistantDelta,
  TurnStarted,
  TurnStepCompleted,
  TurnStepStarted,
} from '#/agent/loop/turnEvents';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import {
  ToolCallStarted,
  ToolProgress,
  ToolResultEvent,
} from '#/agent/toolExecutor/toolExecutorEvents';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
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
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import {
  type ExternalAuthority,
  ISessionExternalDelegationService,
} from '#/session/externalDelegation/externalDelegation';
import { SessionExternalDelegationService } from '#/session/externalDelegation/externalDelegationService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
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

class TranscriptUnknownEvent extends Event2<Record<string, never>> {
  static override readonly type = 'transcript.unmapped';
}

describe('SessionExternalDelegationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let documents: Map<string, unknown>;
  let handles: Map<string, IAgentScopeHandle>;
  let agentMetas: Record<string, AgentMeta>;
  let completions: Array<{ resolve(value: { summary: string; usage?: TokenUsage }): void; reject(error: unknown): void }>;
  let nextRunHandleGate: Promise<void> | undefined;
  let runSignals: AbortSignal[];
  let runAgentIds: string[];
  let runPrompts: string[];
  let createdWith: unknown[];
  let willClose: Emitter<SessionWillCloseEvent & IWaitUntil>;
  let logCalls: Array<{ msg: string; payload: unknown }>;
  let sentMessages: Parameters<IAgentCollaborationMessagingService['send']>[0][];
  let messagesByKey: Map<string, AgentMessageAcceptance>;
  let agentEvents: Map<string, Emitter<Event2<any>>>;
  let wireRecords: Map<string, WireRecord[]>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    documents = new Map();
    handles = new Map();
    agentMetas = { main: { type: 'main', labels: {} } };
    completions = [];
    nextRunHandleGate = undefined;
    runSignals = [];
    runAgentIds = [];
    runPrompts = [];
    createdWith = [];
    logCalls = [];
    sentMessages = [];
    messagesByKey = new Map();
    agentEvents = new Map();
    wireRecords = new Map();

    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IAtomicDocumentStore, {
      _serviceBrand: undefined,
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
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
    ): IAgentScopeHandle => {
      const agent = new TestInstantiationService();
      disposables.add(agent);
      const eventEmitter = disposables.add(new Emitter<Event2<any>>());
      agentEvents.set(id, eventEmitter);
      agent.set(IEventBus, {
        _serviceBrand: undefined,
        publish: (event: Event2<any>) => eventEmitter.fire(event),
        subscribe: (...args: unknown[]) => eventEmitter.event(
          (typeof args[0] === 'function' ? args[0] : args[1]) as (event: Event2<any>) => void,
        ),
      } as IEventBus);
      wireRecords.set(id, []);
      agent.set(IWireService, {
        _serviceBrand: undefined,
        seal: async () => {},
        appendRecord: (record: WireRecord) => { wireRecords.get(id)!.push(record); },
        readJournal: () => (async function* () {
          yield* wireRecords.get(id)!;
        })(),
        flush: async () => {},
      });
      agent.stub(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => ({ modelAlias, modelCapabilities: UNKNOWN_CAPABILITY, profileName, profileDefinitionId, thinkingLevel, systemPrompt: '', subagents: ['coder'] }),
      });
      agent.stub(IAgentPermissionModeService, { mode: 'auto', setMode: () => {} });
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
        const agentId = opts?.agentId ?? 'external-child';
        const handle = makeHandle(
          agentId,
          opts?.binding?.profile ?? 'coder',
          opts?.binding?.model,
          opts?.binding?.thinking,
          opts?.binding?.resolvedProfile?.definitionId,
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
        let resolve!: (value: { summary: string; usage?: TokenUsage }) => void;
        let reject!: (error: unknown) => void;
        const completion = new Promise<{ summary: string; usage?: TokenUsage }>((res, rej) => { resolve = res; reject = rej; });
        completions.push({ resolve, reject });
        return { agentId, turn: {} as never, completion };
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

  it('projects turn detail into the normalized executor vocabulary and L1 items', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'turn_reader',
      profileName: 'coder',
      message: 'work',
    });
    const events = agentEvents.get('external-child')!;

    events.fire(new TurnStarted({ turnId: 1, origin: { kind: 'user' }, prompt: 'work' }));
    events.fire(new TurnStepStarted({ turnId: 1, step: 1, stepId: 's1' }));
    events.fire(new AssistantDelta({ turnId: 1, step: 1, stepId: 's1', partId: 'm1', delta: 'hello' }));
    events.fire(new ToolCallStarted({ turnId: 1, toolCallId: 'tool-1', name: 'Read', args: { path: 'a.ts' } }));
    events.fire(new ToolProgress({ turnId: 1, toolCallId: 'tool-1', update: { kind: 'status', text: 'reading' } }));
    events.fire(new ToolResultEvent({ turnId: 1, toolCallId: 'tool-1', output: 'done' }));
    events.fire(new TurnStepCompleted({
      turnId: 1,
      step: 1,
      stepId: 's1',
      usage: { inputOther: 10, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
    }));
    events.fire(new AgentStatusUpdated({ contextTokens: 13, maxContextTokens: 128 }));
    events.fire(new TranscriptUnknownEvent({}));
    events.fire(new TurnStarted({ turnId: 2, origin: { kind: 'user' }, prompt: 'next' }));

    const turnEvents = await service.events({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'turn',
    });
    expect(turnEvents.items.map((item) => item.event.type)).toEqual([
      'message.delta',
      'tool.call',
      'tool.update',
      'tool.update',
      'usage',
      'unknown',
    ]);
    expect(turnEvents.items[1]?.event).toMatchObject({
      type: 'tool.call',
      toolCallId: 'tool-1',
      title: 'Read',
      rawInput: { path: 'a.ts' },
    });

    const first = await service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      kind: 'turn',
      turnId: 't1',
      prompt: 'work',
      steps: [{
        stepId: 's1',
        frames: [
          { kind: 'text', text: 'hello' },
          { kind: 'tool', toolCallId: 'tool-1', state: 'done', output: 'done' },
        ],
      }],
    });
    expect(first.nextCursor).toBeDefined();
    await expect(service.transcript({
      authority,
      dispatchId: dispatch.dispatchId,
      detail: 'items',
      cursor: first.nextCursor,
      limit: 1,
    })).resolves.toMatchObject({ items: [{ kind: 'turn', turnId: 't2', prompt: 'next' }] });
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
          endedAt: 7,
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
