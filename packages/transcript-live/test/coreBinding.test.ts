import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentTaskService,
  IEventBus,
  ISessionIndex,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionLifecycleService,
  ISessionManager,
  IWorkspaceInstanceManager,
  LifecycleScope,
  SessionInteractionService,
  StateRegistry,
  type Event2,
  type ISessionScopeHandle,
  type ISessionStateService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  AgentTranscript,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  type AgentTranscriptSnapshot,
  type AppendOp,
  type FrameUpsertOp,
  type InteractionUpsertOp,
  type TranscriptFrame,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentTranscriptLiveAdapter,
  bindSessionTranscript,
  type LiveAdapterBusEvent,
} from '../src';

function ev(payload: Record<string, unknown>): LiveAdapterBusEvent {
  return payload as unknown as LiveAdapterBusEvent;
}

class TestSessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

function turnOps(turnId: string, items: ReturnType<AgentTranscript['getItems']>): TranscriptTurn {
  const turn = items.find(
    (item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId,
  );
  if (turn === undefined) throw new Error(`turn ${turnId} not found`);
  return turn;
}

describe('bindSessionTranscript', () => {
  class FakeBus {
    private readonly handlers = new Set<(event: Event2<any>) => void>();
    subscribe(cb: (event: Event2<any>) => void): { dispose: () => void } {
      this.handlers.add(cb);
      return { dispose: () => this.handlers.delete(cb) };
    }
    emit(event: Event2<any>): void {
      for (const cb of this.handlers) cb(event);
    }
  }

  interface FakeAgentHandle {
    readonly id: string;
    readonly bus: FakeBus;
    readonly accessor: { get: (token: unknown) => unknown };
  }

  class FakeAgents {
    private readonly handles = new Map<string, FakeAgentHandle>();
    private readonly createHandlers = new Set<(handle: FakeAgentHandle) => void>();
    private readonly disposeHandlers = new Set<(agentId: string) => void>();
    list(): FakeAgentHandle[] {
      return [...this.handles.values()];
    }
    get(id: string): FakeAgentHandle | undefined {
      return this.handles.get(id);
    }
    onDidCreate(cb: (handle: FakeAgentHandle) => void): { dispose: () => void } {
      this.createHandlers.add(cb);
      return { dispose: () => this.createHandlers.delete(cb) };
    }
    onDidDispose(cb: (agentId: string) => void): { dispose: () => void } {
      this.disposeHandlers.add(cb);
      return { dispose: () => this.disposeHandlers.delete(cb) };
    }
    add(id: string, opts?: { loopStatus?: unknown; tasks?: readonly unknown[]; prompts?: { active?: unknown; pending?: readonly unknown[] } }): FakeAgentHandle {
      const bus = new FakeBus();
      const handle: FakeAgentHandle = {
        id,
        bus,
        accessor: {
          get: (token: unknown) => {
            if (token === IEventBus) return bus;
            if (token === IAgentLoopService) {
              return { status: () => opts?.loopStatus ?? { state: 'idle' } };
            }
            if (token === IAgentActivityView) {
              const status = opts?.loopStatus as
                | { state?: unknown; activeTurnId?: unknown }
                | undefined;
              const turnId =
                status?.state === 'running' && typeof status.activeTurnId === 'number'
                  ? status.activeTurnId
                  : undefined;
              return { state: () => ({ turn: turnId === undefined ? undefined : { turnId, step: 1 } }) };
            }
            if (token === IAgentTaskService) {
              return { list: () => opts?.tasks ?? [] };
            }
            if (token === IAgentPromptService) {
              return { list: () => ({ active: opts?.prompts?.active, pending: opts?.prompts?.pending ?? [] }) };
            }
            return undefined;
          },
        },
      };
      this.handles.set(id, handle);
      for (const cb of this.createHandlers) cb(handle);
      return handle;
    }
    remove(id: string): void {
      this.handles.delete(id);
      for (const cb of this.disposeHandlers) cb(id);
    }
  }

  function fakeSession(
    interactions: SessionInteractionService,
    agents?: FakeAgents,
  ): ISessionScopeHandle {
    return {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentLifecycleService) {
            return (
              agents ?? {
                list: () => [],
                onDidCreate: () => ({ dispose: () => undefined }),
                onDidDispose: () => ({ dispose: () => undefined }),
              }
            );
          }
          if (token === ISessionInteractionService) return interactions;
          if (token === ISessionMetadata) return { read: async () => ({ agents: {} }) };
          return undefined;
        },
      },
    } as unknown as ISessionScopeHandle;
  }

  it('keeps durable prompt ownership structurally identical across cold and live projection', () => {
    const promptRecord = {
      type: 'turn.prompt',
      turnId: 0,
      promptId: 'prompt-1',
      revision: 3,
      lineage: { replacesMessageId: 'old-1' },
      input: [
        { type: 'text', text: '<skill>review</skill>' },
        { type: 'text', text: 'caller prompt' },
        { type: 'image_url', imageUrl: { id: 'file-1' } },
      ],
      origin: {
        kind: 'user',
        skillActivations: [{ activationId: 'act-review', skillName: 'review' }],
      },
      time: 1_000,
    } as const;
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    coldReducer.apply(coldAdapter.add(promptRecord));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const accepted: TranscriptOperation[] = [];
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
      undefined,
      (event) => accepted.push(...event.ops),
    );
    main.bus.emit(promptRecord as unknown as Event2<any>);
    const acceptedBeforeStarted = accepted.length;
    main.bus.emit(
      ev({
        type: 'turn.started',
        turnId: 0,
        origin: { kind: 'user' },
        prompt: 'wrong transient prompt',
        promptAttachments: [{ kind: 'image', fileId: 'wrong-file' }],
      }),
    );

    const live = store.getAgent('main')!;
    expect(live.snapshot()).toEqual(cold.snapshot());
    expect(accepted).toHaveLength(acceptedBeforeStarted);
    expect(live.getTurn('t0')).toMatchObject({
      prompt: 'caller prompt',
      attachmentIds: ['t0.att1'],
      message: {
        messageId: 'prompt-1',
        revision: 3,
        lineage: { replacesMessageId: 'old-1' },
      },
    });

    const marker = cold.getItems()[0];
    const overlapReducer = new TranscriptFactReducer(cold);
    const overlapAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    expect(overlapReducer.apply(overlapAdapter.add(promptRecord)).acceptedOperations).toEqual([]);
    expect(cold.getItems()[0]).toBe(marker);
    binding.dispose();
  });

  it('registers pre-bind pendings without frames and replays an early resolve at seed time', () => {
    const interactions = new SessionInteractionService(new TestSessionStateService());
    interactions.enqueue({
      id: 'apr-1',
      kind: 'approval',
      payload: { toolCallId: 'call_1' },
      origin: { agentId: 'main', turnId: 0 },
    });

    const store = new TranscriptStore('s1');
    const ops: TranscriptOperation[] = [];
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) =>
      ops.push(...event.ops),
    );

    expect(ops).toHaveLength(0);

    interactions.respond('apr-1', { decision: 'approved' });
    expect(ops).toHaveLength(0);

    binding.seedPendingInteractions();
    const states = ops
      .filter((op): op is InteractionUpsertOp => op.op === 'interaction.upsert')
      .map((op) => op.interaction.state);
    expect(states).toEqual(['pending', 'approved']);
    binding.dispose();
  });

  it('keeps the materialized transcript and roster entry when an agent is disposed', () => {
    const agents = new FakeAgents();
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    const sub = agents.add('sub-1');
    agents.add('main');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'scan' }));
    sub.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);

    agents.remove('sub-1');
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);
    const descriptor = store.agents().find((a) => a.agentId === 'sub-1');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.disposedAt).toBe('string');
    expect(store.agents().find((a) => a.agentId === 'main')?.disposedAt).toBeUndefined();
    binding.dispose();
  });

  it('seeds pre-attach Agent task mappings so a late-bound liveAdapter folds the lifecycle', () => {
    const agents = new FakeAgents();
    const tasks = [
      {
        taskId: 'task-9',
        kind: 'agent',
        agentId: 'agent-1',
        status: 'running',
        description: 'Inspect',
        detached: false,
        startedAt: 1_700_000_000_000,
        collaborationTaskName: 'coder',
        profile: 'coder',
      },
      {
        taskId: 'task-10',
        kind: 'agent',
        agentId: 'agent-2',
        status: 'running',
        description: 'Inspect anonymously',
        detached: false,
        startedAt: 1_700_000_001_000,
        profile: 'coder',
      },
    ];
    agents.add('main', { tasks });
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    expect(store.getAgent('main')?.getTask('task-9')).toMatchObject({
      kind: 'subagent',
      state: 'running',
      detached: false,
      name: 'coder',
      subagentName: 'coder',
      description: 'Inspect',
      agentId: 'agent-1',
    });
    expect(store.getAgent('main')?.getTask('task-10')).toMatchObject({
      name: undefined,
      subagentName: 'coder',
      agentId: 'agent-2',
    });

    binding.seedRunningTasks('main');
    expect(store.getAgent('main')?.getTask('task-9')?.state).toBe('running');
    tasks.length = 0;

    agents.get('main')!.bus.emit(ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }));

    expect(store.getAgent('main')?.getTask('task-9')).toMatchObject({
      state: 'completed',
      resultSummary: 'done',
      detached: false,
    });
    expect(store.getAgent('main')?.getTask('agent-1')).toBeUndefined();
    binding.dispose();
  });

  it('routes task notifications and subagent lifecycle through one live owner', () => {
    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
    main.bus.emit(ev({ type: 'turn.step.started', turnId: 0, step: 1, stepId: 'step-1' }));
    main.bus.emit(
      ev({
        type: 'tool.call.started',
        turnId: 0,
        toolCallId: 'call-agent',
        name: 'Agent',
        args: {},
      }),
    );
    main.bus.emit(
      ev({
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'explore',
        parentToolCallId: 'call-agent',
        description: 'Inspect',
        runInBackground: true,
        taskId: 'task-9',
      }),
    );
    main.bus.emit(ev({ type: 'subagent.started', time: 3_000, subagentId: 'agent-1' }));
    main.bus.emit(
      ev({
        type: 'task.notified',
        time: 4_000,
        notificationType: 'completed',
        title: 'Agent completed',
        body: 'done',
        severity: 'info',
        sourceKind: 'agent',
        sourceId: 'task-9',
      }),
    );
    main.bus.emit(
      ev({
        type: 'subagent.completed',
        time: 5_000,
        subagentId: 'agent-1',
        resultSummary: 'done',
      }),
    );

    const turn = store.getAgent('main')?.getTurn('t0');
    const notificationFrames = turn?.steps
      .flatMap((step) => step.frames)
      .filter((frame) => frame.kind === 'text' && frame.taskId === 'task-9');
    const tool = turn?.steps
      .flatMap((step) => step.frames)
      .find((frame) => frame.kind === 'tool' && frame.toolCallId === 'call-agent');
    expect(notificationFrames).toHaveLength(1);
    expect(tool).toMatchObject({ agentRefs: [{ agentId: 'agent-1', role: 'child' }] });
    expect(store.getAgent('main')?.getTask('task-9')).toMatchObject({
      state: 'completed',
      resultSummary: 'done',
      startedAt: new Date(2_000).toISOString(),
      endedAt: new Date(5_000).toISOString(),
    });
    expect(store.getAgent('main')?.getTask('agent-1')).toBeUndefined();
    binding.dispose();
  });

  it('seeds active and queued prompts from the prompt service on attach', () => {
    const agents = new FakeAgents();
    agents.add('main', {
      prompts: {
        active: {
          id: 'p-run',
          userMessageId: 'm-run',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'running',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        },
        pending: [
          {
            id: 'p-queue',
            userMessageId: 'm-queue',
            createdAt: '2026-01-01T00:00:01.000Z',
            state: 'pending',
            message: { role: 'user', content: [{ type: 'text', text: 'later' }] },
          },
        ],
      },
    });
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    binding.seedPrompts('main');
    expect(store.getAgent('main')?.getPrompt('p-run')).toMatchObject({
      promptId: 'p-run',
      status: 'running',
    });
    expect(store.getAgent('main')?.getPrompt('p-queue')).toMatchObject({
      promptId: 'p-queue',
      status: 'queued',
    });
    binding.dispose();
  });

  it('stops projecting for an agent once it is disposed', () => {
    const agents = new FakeAgents();
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    const sub = agents.add('sub-1');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'scan' }));
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);

    agents.remove('sub-1');
    sub.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    expect(store.getAgent('sub-1')?.getItems()[0]).toMatchObject({ kind: 'turn', state: 'running' });
    binding.dispose();
  });

  it('deduplicates wire and live terminal turn.upserts while preserving the backfilled header', () => {
    const agents = new FakeAgents();
    const store = new TranscriptStore('s1');
    const ops: TranscriptOperation[] = [];
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
      undefined,
      (event) => ops.push(...event.ops),
    );
    const main = agents.add('main');

    store.ensureAgent('main').apply([
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: 'att_1',
          mediaType: 'image/*',
          name: 'shot.png',
          source: { kind: 'file', fileId: 'f_1' },
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'running',
          origin: { kind: 'user' },
          prompt: 'hi',
          attachmentIds: ['att_1'],
          startedAt: '2026-08-04T00:00:00.000Z',
        },
      },
    ]);

    main.bus.emit(
      ev({ type: 'turn.ended', time: 1_700_000_000_000, turnId: 0, reason: 'completed' }),
    );

    const terminal = ops.filter((op) => op.op === 'turn.upsert');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      turn: {
        turnId: 't0',
        state: 'completed',
        origin: { kind: 'user' },
        prompt: 'hi',
        attachmentIds: ['att_1'],
        startedAt: '2026-08-04T00:00:00.000Z',
        endedAt: '2023-11-14T22:13:20.000Z',
      },
    });
    expect(store.getAgent('main')?.getTurn('t0')).toMatchObject({
      state: 'completed',
      prompt: 'hi',
      attachmentIds: ['att_1'],
    });
    binding.dispose();
  });

  it('seeds pending interactions per agent, not before that agent is backfilled', () => {
    const interactions = new SessionInteractionService(new TestSessionStateService());
    interactions.enqueue({ id: 'q-main', kind: 'question', payload: { toolCallId: 'call_main' }, origin: { agentId: 'main', turnId: 0 } });
    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });

    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    binding.seedPendingInteractions('main');
    expect([...byAgent.keys()]).toEqual(['main']);

    binding.seedPendingInteractions('sub-1');
    expect([...byAgent.keys()].toSorted()).toEqual(['main', 'sub-1']);
    binding.dispose();
  });

  it('defers pendings created before their owning agent is seeded', () => {
    const interactions = new SessionInteractionService(new TestSessionStateService());
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });
    expect(byAgent.size).toBe(0);

    binding.seedPendingInteractions('main');
    expect(byAgent.size).toBe(0);

    binding.seedPendingInteractions('sub-1');
    expect([...byAgent.keys()]).toEqual(['sub-1']);
    binding.dispose();
  });

  it('announces pendings from live-created agents immediately (their liveAdapter is complete)', () => {
    const agents = new FakeAgents();
    const interactions = new SessionInteractionService(new TestSessionStateService());
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions, agents), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    agents.add('sub-1');
    interactions.enqueue({ id: 'q1', kind: 'question', payload: { toolCallId: 'call_q1' }, origin: { agentId: 'sub-1', turnId: 0 } });
    expect([...byAgent.keys()]).toEqual(['sub-1']);
    binding.dispose();
  });

  it('subscribes the bus for an agent whose liveAdapter was seeded before its handle existed', () => {
    const agents = new FakeAgents();
    const interactions = new SessionInteractionService(new TestSessionStateService());
    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions, agents), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    binding.seedPendingInteractions('sub-1');
    expect(byAgent.get('sub-1')?.map((op) => op.op)).toEqual(['interaction.upsert']);

    const sub = agents.add('sub-1');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    expect(byAgent.get('sub-1')!.length).toBeGreaterThan(1);
    binding.dispose();
  });
});
