import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentTaskService,
  IAgentToolRegistryService,
  IEventBus,
  ISessionDispatchService,
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
} from '@kiki/agent-core-v2';
import { projectAgentTranscriptView } from '@kiki/session-core/session/transcript/project';
import { createViewState } from '@kiki/session-core/session/transcript/types';
import { MessageStepRequest } from '@kiki/agent-core-v2/agent/loop/stepRequest';
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
  type TranscriptWireRecord,
} from '@kiki/transcript';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

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

function normalizedBlocks(
  snapshot: AgentTranscriptSnapshot,
): ReadonlyArray<Record<string, unknown>> {
  const blocks = projectAgentTranscriptView(
    createViewState('session_test'),
    'main',
    snapshot,
  ).blocks;
  return JSON.parse(
    JSON.stringify(blocks, (key, value) =>
      key === 'createdAt' || key === 'startedAt' || key === 'endedAt' ? undefined : value,
    ),
  ) as ReadonlyArray<Record<string, unknown>>;
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
    add(id: string, opts?: { loopStatus?: unknown; tasks?: readonly unknown[]; prompts?: { active?: unknown; pending?: readonly unknown[]; hold?: unknown } }): FakeAgentHandle {
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
              return {
                list: () => ({
                  active: opts?.prompts?.active,
                  pending: opts?.prompts?.pending ?? [],
                  hold: opts?.prompts?.hold,
                }),
              };
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

  it('projects observable agent mailbox delivery exactly like its durable context message', () => {
    const message = {
      id: 'agent-message-1',
      role: 'user',
      content: [{ type: 'text', text: 'Message from agent "root" (main):\n\ncheck the tests' }],
      toolCalls: [],
      origin: {
        kind: 'agent_message',
        messageId: 'agent-message-1',
        senderAgentId: 'main',
        senderTaskName: 'root',
      },
    } as const;
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    coldReducer.apply(coldAdapter.add({
      type: 'context.append_message',
      message,
      time: 1_000,
    }));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    main.bus.emit(ev({
      type: 'context.append_message',
      message,
      time: 1_000,
    }) as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    expect(live.snapshot()).toEqual(cold.snapshot());
    expect(normalizedBlocks(live.snapshot())).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'Message from agent "root" (main):\n\ncheck the tests',
        agentMessage: { senderAgentId: 'main', senderTaskName: 'root' },
      }),
    ]);
    binding.dispose();
  });

  it('projects a user-origin steer as a live user frame on the next step', () => {
    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    const emit = (record: Record<string, unknown>): void => {
      main.bus.emit(record as unknown as Event2<any>);
    };

    emit({
      type: 'turn.prompt',
      turnId: 0,
      promptId: 'prompt-1',
      input: [{ type: 'text', text: 'start' }],
      origin: { kind: 'user' },
      time: 1_000,
    });
    emit({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
      time: 2_000,
    });
    emit({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
      time: 3_000,
    });
    emit({
      type: 'turn.steer',
      turnId: 0,
      promptId: 'steer-1',
      input: [{ type: 'text', text: 'steer this' }],
      origin: { kind: 'user' },
      time: 4_000,
    });
    emit({
      type: 'context.append_message',
      message: {
        id: 'steer-1',
        role: 'user',
        content: [{ type: 'text', text: 'steer this' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: 5_000,
    });
    emit({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
      time: 6_000,
    });

    expect(store.getAgent('main')?.getTurn('t0')?.steps[1]?.frames).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        frameId: 'steer-1',
        role: 'user',
        text: 'steer this',
        origin: { kind: 'user' },
      }),
    );
    binding.dispose();
  });

  it('keeps live and cold block projection equivalent after undo', () => {
    const records = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'first' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 1_100,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-1',
          part: { type: 'text', text: 'first answer' },
        },
        time: 1_200,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 1_300,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 },
      {
        type: 'turn.prompt',
        turnId: 1,
        promptId: 'prompt-2',
        input: [{ type: 'text', text: 'second' }],
        origin: { kind: 'user' },
        time: 3_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 1, step: 1, uuid: 'step-2' },
        time: 3_100,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 1,
          stepUuid: 'step-2',
          uuid: 'part-2',
          part: { type: 'text', text: 'second answer' },
        },
        time: 3_200,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 1, step: 1, uuid: 'step-2' },
        time: 3_300,
      },
      { type: 'turn.ended', turnId: 1, reason: 'completed', time: 4_000 },
      { type: 'context.undo', count: 1, time: 5_000 },
    ];
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    const liveBlocks = normalizedBlocks(live.snapshot());
    const coldBlocks = normalizedBlocks(cold.snapshot());
    expect(liveBlocks).toEqual(coldBlocks);
    expect(liveBlocks).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ kind: 'user', turnId: 't1' }),
        expect.objectContaining({ kind: 'assistant', turnId: 't1' }),
      ]),
    );
    expect(liveBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', turnId: 't0', text: 'first' }),
        expect.objectContaining({ kind: 'assistant', turnId: 't0', text: 'first answer' }),
      ]),
    );
    binding.dispose();
  });

  it('keeps legacy mailbox deliveries equivalent across a multi-step turn and the next turn', () => {
    const mailbox = (id: string, time: number): TranscriptWireRecord => ({
      type: 'context.append_message',
      time,
      message: {
        id,
        role: 'user',
        content: [{ type: 'text', text: `mailbox ${id}` }],
        toolCalls: [],
        origin: { kind: 'agent_message', messageId: id, senderAgentId: 'agent-1', senderTaskName: 'worker' },
      },
    });
    const records = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-1',
          part: { type: 'text', text: 'before' },
        },
        time: 2_500,
      },
      mailbox('mail-1', 3_000),
      mailbox('mail-2', 3_100),
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1', finishReason: 'stop' },
        time: 3_500,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 4_000,
      },
      mailbox('mail-3', 4_100),
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-2',
          uuid: 'part-2',
          part: { type: 'text', text: 'after' },
        },
        time: 4_500,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 6_000 },
      {
        type: 'turn.prompt',
        turnId: 1,
        promptId: 'prompt-2',
        input: [{ type: 'text', text: 'next' }],
        origin: { kind: 'user' },
        time: 7_000,
      },
      mailbox('mail-1', 3_000),
    ];
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    expect(live.snapshot()).toEqual(cold.snapshot());
    expect(
      live.getItems().filter((item) => item.kind === 'turn').map((item) => (item as TranscriptTurn).turnId),
    ).toEqual(['t0', 't1']);
    const frames = live.getTurn('t0')?.steps.flatMap((step) => step.frames) ?? [];
    expect(
      frames
        .filter((frame) => frame.kind === 'text' && frame.role === 'user')
        .map((frame) => (frame as { frameId: string }).frameId),
    ).toEqual(['mail-1', 'mail-2', 'mail-3']);
    expect(frames[1]).toMatchObject({
      kind: 'text',
      frameId: 'mail-1',
      delivery: { messageId: 'mail-1', turnId: 't0', stepId: 'step-1', origin: 'mailbox' },
    });
    expect(live.getTurn('t1')?.steps).toEqual([]);
    binding.dispose();
  });

  it('keeps cold and live mailbox facts identical with time fields preserved', () => {
    const message = {
      id: 'agent-message-2',
      role: 'user',
      content: [{ type: 'text', text: 'mid-run mailbox' }],
      toolCalls: [],
      origin: { kind: 'agent_message', messageId: 'agent-message-2', senderAgentId: 'agent-2' },
    } as const;
    const promptRecord = {
      type: 'turn.prompt', turnId: 0, promptId: 'p', input: [{ type: 'text', text: 'go' }], origin: { kind: 'user' }, time: 1_000,
    } as const;
    const stepBegin = {
      type: 'context.append_loop_event', time: 1_500, event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
    } as const;
    const mailboxRecord = { type: 'context.append_message', message, time: 2_000 } as const;
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of [promptRecord, stepBegin, mailboxRecord]) {
      coldReducer.apply(coldAdapter.add(record));
    }

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of [promptRecord, stepBegin, mailboxRecord]) {
      main.bus.emit(record as unknown as Event2<any>);
    }
    expect(store.getAgent('main')!.snapshot()).toEqual(cold.snapshot());
    binding.dispose();
  });

  it(
    'keeps the cold facts rebuild identical to the live transcript across a dual-path mailbox delivery',
    { timeout: 30_000 },
    async () => {
      const { createAgentToolContext, createAgentLifecycleStub } = await import('./helpers/agentToolFixture');
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => ({ summary: 'finished immediately' }),
      });
      const ctx = createAgentToolContext(lifecycle);
      onTestFinished(async () => {
        await ctx.dispose();
      });

      const store = new TranscriptStore('s1');
      const interactions = new SessionInteractionService(new TestSessionStateService());
      const bus = ctx.get(IEventBus);
      const agents = new FakeAgents();
      const main = agents.add('main', { loopStatus: { state: 'idle' } });
      const session = {
        accessor: {
          get: (token: unknown) => {
            if (token === IAgentLifecycleService) return agents;
            if (token === ISessionInteractionService) return interactions;
            if (token === ISessionMetadata) return { read: async () => ({ agents: {} }) };
            return undefined;
          },
        },
      } as unknown as ISessionScopeHandle;
      const binding = bindSessionTranscript(store, session);
      const forwarder = bus.subscribe((event) => {
        main.bus.emit(event);
      });
      onTestFinished(() => forwarder.dispose());

      const memory = ctx.context;
      memory.appendObservable({
        id: 'mailbox-dual-path',
        role: 'user',
        content: [{ type: 'text', text: 'Message from agent "worker" (main):\n\ndual path check' }],
        toolCalls: [],
        origin: { kind: 'agent_message', messageId: 'mailbox-dual-path', senderAgentId: 'agent-child', senderTaskName: 'worker' },
      });

      const live = store.getAgent('main')!;

      const captured = await ctx.persistedWireRecords();
      const deliveryRecords = captured.filter(
        (record) => record.type === 'context.append_message' && record['delivery'] !== undefined,
      );
      expect(deliveryRecords.length).toBe(1);
      expect(deliveryRecords[0]).toMatchObject({
        delivery: { messageId: 'mailbox-dual-path', origin: 'mailbox' },
      });
      const cold = new AgentTranscript('main');
      const coldReducer = new TranscriptFactReducer(cold);
      const coldAdapter = new TranscriptWireAdapter('main', {
        turn: (turnId) => cold.getTurn(turnId),
      });
      for (const record of captured) coldReducer.apply(coldAdapter.add(record));
      coldReducer.apply(coldAdapter.finish());

      expect(live.snapshot()).toEqual(cold.snapshot());
      const frames = live.getItems().flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []));
      const markers = live.getItems().filter((item) => item.kind === 'marker' && (item as { marker: string }).marker === 'message.delivery');
      const mailboxFrames = frames.filter(
        (frame) => frame.kind === 'text' && (frame as { frameId: string }).frameId === 'mailbox-dual-path',
      );
      expect(mailboxFrames.length + markers.length).toBe(1);
      if (mailboxFrames.length > 0) {
        expect(mailboxFrames[0]).toMatchObject({ kind: 'text', role: 'user', text: 'Message from agent "worker" (main):\n\ndual path check' });
      } else {
        expect(markers[0]).toMatchObject({ kind: 'marker', marker: 'message.delivery' });
      }
      binding.dispose();
    },
  );

  it('preserves durable step timestamps when a live completion follows the recorded step end', () => {
    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(store, fakeSession(new SessionInteractionService(new TestSessionStateService()), agents));
    onTestFinished(() => binding.dispose());
    const records = [
      { type: 'turn.prompt', turnId: 0, promptId: 'timed', input: [{ type: 'text', text: 'start' }], origin: { kind: 'user' }, time: 1_000 },
      { type: 'turn.step.started', turnId: 0, step: 1, stepId: 'timed-step', time: 1_500 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'timed-step' }, time: 2_000 },
      { type: 'context.append_loop_event', event: { type: 'step.end', turnId: 0, step: 1, uuid: 'timed-step' }, time: 4_000 },
      { type: 'turn.step.completed', turnId: 0, step: 1, stepId: 'timed-step', time: 5_000 },
    ];
    for (const record of records) main.bus.emit(ev(record));
    expect(store.getAgent('main')?.getTurn('t0')?.steps[0]).toMatchObject({
      startedAt: new Date(2_000).toISOString(), endedAt: new Date(4_000).toISOString(),
    });
  });

  it(
    'projects a real managed opening delivery through the actual loop pipeline with exactly one delivery',
    { timeout: 30_000 },
    async () => {
      const { createAgentToolContext, createAgentLifecycleStub } = await import('./helpers/agentToolFixture');
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => ({ summary: 'finished immediately' }),
      });
      const ctx = createAgentToolContext(lifecycle);
      onTestFinished(async () => {
        await ctx.dispose();
      });

      const store = new TranscriptStore('s1');
      const interactions = new SessionInteractionService(new TestSessionStateService());
      const bus = ctx.get(IEventBus);
      const agents = new FakeAgents();
      const main = agents.add('main', { loopStatus: { state: 'idle' } });
      const session = {
        accessor: {
          get: (token: unknown) => {
            if (token === IAgentLifecycleService) return agents;
            if (token === ISessionInteractionService) return interactions;
            if (token === ISessionMetadata) return { read: async () => ({ agents: {} }) };
            return undefined;
          },
        },
      } as unknown as ISessionScopeHandle;
      const binding = bindSessionTranscript(store, session);
      const forwarder = bus.subscribe((event) => {
        main.bus.emit(event);
      });
      onTestFinished(() => forwarder.dispose());

      ctx.mockNextResponse({ type: 'text', text: 'Opening answer.' });
      const launch = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'managed opening' }], promptId: 'prompt-real' });
      expect(launch).toMatchObject({ turn_id: 0 });

      const live = store.getAgent('main')!;
      const turn = live.getTurn('t0')!;
      expect(turn.prompt).toBe('managed opening');
      expect(turn.message).toMatchObject({ messageId: 'prompt-real' });
      const openingDeliveries = turn.steps
        .flatMap((step) => step.frames)
        .filter((frame) => frame.kind === 'text' && (frame as { frameId: string }).frameId === 'prompt-real');
      expect(openingDeliveries).toHaveLength(0);

      const captured = await ctx.persistedWireRecords();
      const openingDeliveryRecords = captured.filter(
        (record) =>
          record.type === 'context.append_message' &&
          (record['delivery'] as { messageId?: string } | undefined)?.messageId === 'prompt-real',
      );
      expect(openingDeliveryRecords.length).toBe(1);
      const openingDelivery = openingDeliveryRecords[0]!['delivery'] as {
        deliveryId: string;
        messageId: string;
        turnId?: number;
        stepId?: string;
        step?: number;
        deliveredAt: string;
        origin: string;
      };
      expect(openingDelivery.deliveryId).toBeDefined();
      expect(openingDelivery.messageId).toBe('prompt-real');
      expect(openingDelivery.turnId).toBe(0);
      expect(openingDelivery.stepId).toBeDefined();
      expect(openingDelivery.step).toBe(1);
      expect(openingDelivery.deliveredAt).toBeDefined();
      expect(openingDelivery.origin).toBe('user');

      const cold = new AgentTranscript('main');
      const coldReducer = new TranscriptFactReducer(cold);
      const coldAdapter = new TranscriptWireAdapter('main', {
        turn: (turnId) => cold.getTurn(turnId),
      });
      for (const record of captured) coldReducer.apply(coldAdapter.add(record));
      coldReducer.apply(coldAdapter.finish());
      const coldTurn = cold.getTurn('t0')!;
      expect(coldTurn.prompt).toBe('managed opening');
      expect(coldTurn.delivery).toMatchObject({
        messageId: 'prompt-real',
        origin: 'user',
        deliveredAt: openingDelivery.deliveredAt,
        turnId: 't0',
        stepId: openingDelivery.stepId,
        step: 1,
      });
      expect(coldTurn.delivery?.deliveryId).toBe(openingDelivery.deliveryId);
      const liveFrames = turn.steps.flatMap((step) => step.frames);
      const coldFrames = coldTurn.steps.flatMap((step) => step.frames);
      const liveUserFrames = liveFrames.filter((frame) => frame.kind === 'text' && frame.role === 'user');
      const coldUserFrames = coldFrames.filter((frame) => frame.kind === 'text' && frame.role === 'user');
      expect(liveUserFrames).toEqual(coldUserFrames);
      expect(liveUserFrames).toHaveLength(0);
      binding.dispose();
    },
  );

  it(
    'projects a real mid-turn managed delivery from an enqueued step request through the actual loop pipeline',
    { timeout: 30_000 },
    async () => {
      const { createAgentToolContext, createAgentLifecycleStub } = await import('./helpers/agentToolFixture');
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => ({ summary: 'finished immediately' }),
      });
      const ctx = createAgentToolContext(lifecycle);
      onTestFinished(async () => {
        await ctx.dispose();
      });

      const store = new TranscriptStore('s1');
      const interactions = new SessionInteractionService(new TestSessionStateService());
      const bus = ctx.get(IEventBus);
      const agents = new FakeAgents();
      const main = agents.add('main', { loopStatus: { state: 'idle' } });
      const session = {
        accessor: {
          get: (token: unknown) => {
            if (token === IAgentLifecycleService) return agents;
            if (token === ISessionInteractionService) return interactions;
            if (token === ISessionMetadata) return { read: async () => ({ agents: {} }) };
            return undefined;
          },
        },
      } as unknown as ISessionScopeHandle;
      const binding = bindSessionTranscript(store, session);
      const forwarder = bus.subscribe((event) => {
        main.bus.emit(event);
      });
      onTestFinished(() => forwarder.dispose());

      const loop = ctx.get(IAgentLoopService);
      let enqueued = false;
      loop.hooks.onDidFinishStep.register('test-mid-turn-delivery', async (_hookCtx, next) => {
        if (!enqueued) {
          enqueued = true;
          loop.enqueue(
            new MessageStepRequest({
              id: 'mail-mid-turn',
              role: 'user',
              content: [{ type: 'text', text: 'Message from agent "worker" (mid-turn):\n\nreal pipeline delivery' }],
              toolCalls: [],
              origin: { kind: 'agent_message', messageId: 'mail-mid-turn', senderAgentId: 'agent-child', senderTaskName: 'worker' },
            }),
          );
        }
        await next();
      });

      ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
      ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
      await ctx.untilTurnEnd();

      const live = store.getAgent('main')!;
      const turn = live.getTurn('t0')!;
      expect(turn.state).toBe('completed');
      const allUserFrames = turn.steps.flatMap((step) => step.frames)
        .filter((frame) => frame.kind === 'text' && frame.role === 'user');
      expect(allUserFrames).toHaveLength(1);
      const textFrame = allUserFrames[0] as Extract<TranscriptFrame, { kind: 'text' }>;
      expect(textFrame).toMatchObject({
        frameId: 'mail-mid-turn',
        text: 'Message from agent "worker" (mid-turn):\n\nreal pipeline delivery',
        delivery: { messageId: 'mail-mid-turn', turnId: 't0', step: 2, origin: 'mailbox' },
      });
      const anchoredStep = turn.steps.find((step) => step.ordinal === 2)!;
      expect(textFrame.delivery?.stepId).toBe(anchoredStep.stepId);
      expect(anchoredStep.frames).toContainEqual(textFrame);

      const captured = await ctx.persistedWireRecords();
      const midDeliveryRecords = captured.filter(
        (record) => record.type === 'context.append_message' &&
          (record['delivery'] as { origin?: string } | undefined)?.origin === 'mailbox',
      );
      expect(midDeliveryRecords).toHaveLength(1);
      expect(midDeliveryRecords[0]).toMatchObject({
        message: { id: 'mail-mid-turn' },
        delivery: { ...textFrame.delivery, turnId: 0 },
      });
      expect(textFrame.delivery?.deliveryId).toEqual(expect.any(String));
      expect(textFrame.delivery?.deliveredAt).toEqual(expect.any(String));

      const cold = new AgentTranscript('main');
      const coldReducer = new TranscriptFactReducer(cold);
      const coldAdapter = new TranscriptWireAdapter('main', {
        turn: (turnId) => cold.getTurn(turnId),
      });
      for (const record of captured) coldReducer.apply(coldAdapter.add(record));
      coldReducer.apply(coldAdapter.finish());
      const coldMailboxFrames = cold.getTurn('t0')!.steps
        .flatMap((step) => step.frames)
        .filter((frame) => frame.kind === 'text' && frame.role === 'user' && (frame as { delivery?: { origin?: string } }).delivery?.origin === 'mailbox');
      expect(coldMailboxFrames).toEqual(allUserFrames);
      expect(coldMailboxFrames).toHaveLength(1);

      const liveBlocks = projectAgentTranscriptView(
        createViewState('session_test'), 'main', live.snapshot(),
      ).blocks;
      const coldBlocks = projectAgentTranscriptView(
        createViewState('session_test'), 'main', cold.snapshot(),
      ).blocks;
      expect(liveBlocks).toEqual(coldBlocks);
      expect(liveBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'user',
            text: 'Message from agent "worker" (mid-turn):\n\nreal pipeline delivery',
          }),
        ]),
      );
      binding.dispose();
    },
  );

  it('keeps live and cold task notification blocks equivalent without a user bubble', () => {
    const records = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'Run the fixture suite in the background.' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-1',
          part: { type: 'text', text: 'Started the suite as a background task.' },
        },
        time: 2_500,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
      {
        type: 'task.notified',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'pnpm test — 42 passed',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'task-1',
        time: 4_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'notification-message',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<notification id="task:task-1:completed" category="task" type="task.completed" source_kind="background_task" source_id="task-1">\nTitle: Background process completed\npnpm test — 42 passed\n</notification>',
            },
          ],
          toolCalls: [],
          origin: {
            kind: 'task',
            taskId: 'task-1',
            status: 'completed',
            notificationId: 'task:task-1:completed',
          },
        },
        time: 4_100,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-2',
          uuid: 'part-2',
          part: { type: 'text', text: 'Suite is green — 42 passed.' },
        },
        time: 5_500,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 2, uuid: 'step-2' },
        time: 6_000,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 7_000 },
    ];
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    const liveBlocks = normalizedBlocks(live.snapshot());
    const coldBlocks = normalizedBlocks(cold.snapshot());
    expect(liveBlocks).toEqual(coldBlocks);
    expect(liveBlocks.filter((block) => block['kind'] === 'user')).toEqual([
      expect.objectContaining({
        turnId: 't0',
        text: 'Run the fixture suite in the background.',
      }),
    ]);
    expect(liveBlocks.filter((block) => block['kind'] === 'system')).toEqual([
      expect.objectContaining({
        turnId: 't0',
        variant: 'task',
        text: 'Background process completed\npnpm test — 42 passed',
      }),
    ]);
    expect(live.getTurn('t1')).toBeUndefined();
    binding.dispose();
  });

  it('keeps foreground subagent terminals, interactions, and ended phase block-equivalent', () => {
    const records = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-foreground',
        input: [{ type: 'text', text: 'Inspect the session.' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-agent-run',
          toolCallId: 'call-agent-run',
          name: 'AgentRun',
          args: { profile: 'explore', prompt: 'Inspect the session.' },
        },
        time: 2_100,
      },
      {
        type: 'subagent.spawned',
        subagentId: 'agent-1',
        subagentName: 'explore',
        name: 'session_inspector',
        parentToolCallId: 'call-agent-run',
        description: 'Inspect the session.',
        runInBackground: false,
        taskId: 'task-foreground',
        time: 2_200,
      },
      { type: 'subagent.started', subagentId: 'agent-1', time: 2_300 },
      {
        type: 'interaction.request',
        id: 'approval-1',
        kind: 'approval',
        toolCallId: 'call-agent-run',
        request: { toolCallId: 'call-agent-run', action: 'Inspect' },
        origin: { agentId: 'main', turnId: 0 },
        time: 2_400,
      },
      {
        type: 'interaction.resolved',
        id: 'approval-1',
        response: { decision: 'approved', scope: 'session' },
        time: 2_500,
      },
      {
        type: 'subagent.failed',
        subagentId: 'agent-1',
        error: 'terminated',
        time: 3_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          turnId: 0,
          stepUuid: 'step-1',
          toolCallId: 'call-agent-run',
          result: { output: 'terminated', isError: false },
        },
        time: 3_100,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_200,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 2_300, time: 3_300 },
    ];
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
      tool: (toolCallId) => {
        for (const item of cold.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            const frame = step.frames.find(
              (candidate) => candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
            );
            if (frame?.kind === 'tool') return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
        return undefined;
      },
      task: (taskId) => cold.getTask(taskId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    const liveBlocks = normalizedBlocks(live.snapshot());
    expect(liveBlocks).toEqual(normalizedBlocks(cold.snapshot()));
    expect(liveBlocks.filter((block) => block['kind'] === 'subagent')).toEqual([
      expect.objectContaining({
        subagentId: 'agent-1',
        status: 'cancelled',
        name: 'session_inspector',
      }),
    ]);
    expect(liveBlocks.filter((block) => block['kind'] === 'approval')).toHaveLength(1);
    expect(live.getTask('task-foreground')).toMatchObject({
      state: 'killed',
      error: undefined,
      stateReason: 'terminated',
    });
    expect(live.getMeta()).toMatchObject({
      activity: 'idle',
      agent: {
        phase: {
          kind: 'ended',
          turnId: 0,
          reason: 'completed',
          durationMs: 2_300,
          at: 3_300,
        },
      },
    });
    expect(cold.getMeta()).toEqual(live.getMeta());
    binding.dispose();
  });

  it('projects an interrupted live turn as a stopped assistant block', () => {
    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    main.bus.emit(
      ev({
        type: 'turn.started',
        time: 1_000,
        turnId: 1,
        prompt: 'Abort me mid-stream.',
        origin: { kind: 'user' },
      }) as unknown as Event2<any>,
    );
    main.bus.emit(
      ev({ type: 'turn.step.started', time: 1_100, turnId: 1, step: 1, stepId: 'step-1' }) as unknown as Event2<any>,
    );
    main.bus.emit(
      ev({
        type: 'assistant.delta',
        time: 1_200,
        turnId: 1,
        step: 1,
        stepId: 'step-1',
        delta: 'This half-finished sentence keeps streaming',
      }) as unknown as Event2<any>,
    );
    main.bus.emit(
      ev({
        type: 'turn.step.interrupted',
        time: 1_300,
        turnId: 1,
        step: 1,
        stepId: 'step-1',
        reason: 'user_cancelled',
      }) as unknown as Event2<any>,
    );
    main.bus.emit(
      ev({
        type: 'turn.ended',
        time: 1_400,
        turnId: 1,
        reason: 'cancelled',
        interruptReason: 'user_cancelled',
      }) as unknown as Event2<any>,
    );

    const blocks = normalizedBlocks(store.getAgent('main')!.snapshot());
    expect(blocks.filter((block) => block['kind'] === 'assistant')).toEqual([
      expect.objectContaining({
        turnId: 't1',
        text: 'This half-finished sentence keeps streaming',
        stopped: true,
        streaming: false,
      }),
    ]);
    binding.dispose();
  });

  it('assigns stable question and option ids in live transcript entities', () => {
    const adapter = new AgentTranscriptLiveAdapter('main');
    const operations = adapter.mapInteractionRequested({
      id: 'question-1',
      kind: 'question',
      payload: {
        questions: [
          {
            question: 'Choose?',
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
          },
        ],
      },
      origin: { agentId: 'main', turnId: 0 },
      createdAt: 1_000,
    });

    expect(operations[0]).toMatchObject({
      op: 'interaction.upsert',
      interaction: {
        interactionId: 'question-1',
        request: {
          question_id: 'question-1',
          questions: [
            {
              id: 'q_0',
              options: [{ id: 'opt_0_0' }, { id: 'opt_0_1' }],
            },
          ],
        },
      },
    });
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
        type: 'task.started',
        time: 1_900,
        info: {
          taskId: 'task-9',
          kind: 'agent',
          status: 'running',
          agentId: 'agent-1',
          profile: 'explore',
          collaborationTaskName: 'inspect_task',
          description: 'Inspect',
          detached: true,
          startedAt: 1_900,
          endedAt: null,
        },
      }),
    );
    main.bus.emit(
      ev({
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'explore',
        name: 'inspect_task',
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
    main.bus.emit(
      ev({
        type: 'task.terminated',
        time: 5_100,
        info: {
          taskId: 'task-9',
          kind: 'agent',
          status: 'completed',
          agentId: 'agent-1',
          profile: 'explore',
          collaborationTaskName: 'inspect_task',
          description: 'Inspect',
          detached: true,
          startedAt: 1_900,
          endedAt: 5_100,
        },
        outputTail: 'done',
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
      name: 'inspect_task',
      subagentName: 'explore',
      description: 'Inspect',
      outputTail: 'done',
      resultSummary: 'done',
      startedAt: new Date(2_000).toISOString(),
      endedAt: new Date(5_100).toISOString(),
    });
    expect(store.getAgent('main')?.getTask('agent-1')).toBeUndefined();
    binding.dispose();
  });

  it('seeds active, queued, and recovery-held prompt state on attach', () => {
    const agents = new FakeAgents();
    agents.add('main', {
      prompts: {
        active: {
          id: 'p-run',
          userMessageId: 'm-run',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'running',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
          appendTiming: 'subagents_done',
          revision: 4,
        },
        pending: [
          {
            id: 'p-queue',
            userMessageId: 'm-queue',
            createdAt: '2026-01-01T00:00:01.000Z',
            state: 'pending',
            message: { role: 'user', content: [{ type: 'text', text: 'later' }] },
            appendTiming: 'tasks_done',
            revision: 2,
          },
        ],
        hold: { reason: 'recovery', count: 1 },
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
      appendTiming: 'subagents_done',
      revision: 4,
    });
    expect(store.getAgent('main')?.getPrompt('p-queue')).toMatchObject({
      promptId: 'p-queue',
      status: 'queued',
      appendTiming: 'tasks_done',
      revision: 2,
    });
    expect(store.getAgent('main')?.getMeta().promptQueueHold).toEqual({
      reason: 'recovery',
      count: 1,
    });
    binding.dispose();
  });

  it('skips non-user-origin prompts when seeding on attach', () => {
    const agents = new FakeAgents();
    agents.add('main', {
      prompts: {
        active: {
          id: 'p-cron',
          userMessageId: 'm-cron',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'running',
          message: {
            role: 'user',
            origin: { kind: 'cron_job', jobId: 'j1', cron: '* * * * *', recurring: true, coalescedCount: 0, stale: false },
            content: [{ type: 'text', text: '<cron-fire jobId="j1"><prompt>nightly</prompt></cron-fire>' }],
          },
          revision: 1,
        },
        pending: [
          {
            id: 'p-cron-queued',
            userMessageId: 'm-cron-queued',
            createdAt: '2026-01-01T00:00:01.000Z',
            state: 'pending',
            message: {
              role: 'user',
              origin: { kind: 'cron_job', jobId: 'j2', cron: '0 * * * *', recurring: true, coalescedCount: 0, stale: false },
              content: [{ type: 'text', text: '<cron-fire jobId="j2"><prompt>hourly</prompt></cron-fire>' }],
            },
            revision: 1,
          },
          {
            id: 'p-user',
            userMessageId: 'm-user',
            createdAt: '2026-01-01T00:00:02.000Z',
            state: 'pending',
            message: { role: 'user', content: [{ type: 'text', text: 'later' }] },
            revision: 1,
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
    expect(store.getAgent('main')?.getPrompt('p-cron')).toBeUndefined();
    expect(store.getAgent('main')?.getPrompt('p-cron-queued')).toBeUndefined();
    expect(store.getAgent('main')?.getPrompt('p-user')).toMatchObject({
      promptId: 'p-user',
      status: 'queued',
    });
    binding.dispose();
  });

  it('projects live prompt queue timing through the live adapter', () => {
    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );

    main.bus.emit(
      ev({
        type: 'prompt.queued',
        promptId: 'p1',
        content: [{ type: 'text', text: 'later' }],
        queueLength: 1,
        appendTiming: 'tasks_done',
        revision: 1,
      }) as unknown as Event2<any>,
    );
    main.bus.emit(
      ev({
        type: 'prompt.timing_changed',
        promptId: 'p1',
        appendTiming: 'subagents_done',
        revision: 2,
        changedAt: '2026-01-01T00:00:01.000Z',
      }) as unknown as Event2<any>,
    );

    expect(store.getAgent('main')?.getPrompt('p1')).toMatchObject({
      status: 'queued',
      appendTiming: 'subagents_done',
      revision: 2,
      content: [{ type: 'text', text: 'later' }],
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

  it('projects an unanchored canonical delivery onto the unknown-header turn without duplicating it', () => {
    const records = [
      { type: 'turn.started', time: 1_000, turnId: 0, origin: { kind: 'user' } },
      {
        type: 'context.append_message',
        time: 1_500,
        delivery: {
          deliveryId: 'delivery-open', messageId: 'prompt-open', turnId: 0, stepId: 'step-1', step: 1,
          deliveredAt: new Date(1_500).toISOString(), origin: 'user',
        },
        message: {
          id: 'prompt-open',
          role: 'user',
          content: [{ type: 'text', text: 'opening prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      { type: 'turn.ended', time: 2_000, turnId: 0, reason: 'completed' },
    ] as const;
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));
    coldReducer.apply(coldAdapter.finish());

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    const liveFrames = live.getTurn('t0')?.steps.flatMap((step) => step.frames) ?? [];
    const coldFrames = cold.getTurn('t0')?.steps.flatMap((step) => step.frames) ?? [];
    const liveDelivery = liveFrames.filter(
      (frame) => frame.kind === 'text' && (frame as { frameId: string }).frameId === 'prompt-open',
    );
    const coldDelivery = coldFrames.filter(
      (frame) => frame.kind === 'text' && (frame as { frameId: string }).frameId === 'prompt-open',
    );
    expect(liveDelivery).toHaveLength(1);
    expect(liveDelivery).toEqual(coldDelivery);
    expect(liveDelivery[0]).toMatchObject({
      kind: 'text',
      role: 'user',
      text: 'opening prompt',
      delivery: {
        deliveryId: 'delivery-open',
        messageId: 'prompt-open',
        turnId: 't0',
        stepId: 'step-1',
        step: 1,
        deliveredAt: new Date(1_500).toISOString(),
        origin: 'user',
      },
    });
    expect(live.getTurn('t0')?.steps).toHaveLength(1);
    binding.dispose();
  });

  it('fills the managed opening header prompt and delivery from its canonical echo without a same-id user frame', () => {
    const records = [
      {
        type: 'turn.prompt',
        time: 900,
        turnId: 0,
        promptId: 'prompt-open',
        managed: true,
        input: [{ type: 'text', text: 'opening prompt' }],
        origin: { kind: 'user' },
      },
      { type: 'turn.started', time: 1_000, turnId: 0, origin: { kind: 'user' } },
      {
        type: 'context.append_message',
        time: 1_500,
        delivery: {
          deliveryId: 'delivery-open', messageId: 'prompt-open', turnId: 0, stepId: 'step-1', step: 1,
          deliveredAt: new Date(1_500).toISOString(), origin: 'user',
        },
        message: {
          id: 'prompt-open',
          role: 'user',
          content: [{ type: 'text', text: 'opening prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      { type: 'turn.ended', time: 2_000, turnId: 0, reason: 'completed' },
    ] as const;
    const cold = new AgentTranscript('main');
    const coldReducer = new TranscriptFactReducer(cold);
    const coldAdapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => cold.getTurn(turnId),
    });
    for (const record of records) coldReducer.apply(coldAdapter.add(record));
    coldReducer.apply(coldAdapter.finish());

    const agents = new FakeAgents();
    const main = agents.add('main');
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(new TestSessionStateService()), agents),
    );
    for (const record of records) main.bus.emit(record as unknown as Event2<any>);

    const live = store.getAgent('main')!;
    expect(live.snapshot()).toEqual(cold.snapshot());
    const turn = live.getTurn('t0')!;
    expect(turn.prompt).toBe('opening prompt');
    expect(turn.delivery).toMatchObject({
      deliveryId: 'delivery-open',
      messageId: 'prompt-open',
      turnId: 't0',
      stepId: 'step-1',
      step: 1,
      deliveredAt: new Date(1_500).toISOString(),
      origin: 'user',
    });
    expect(turn.message).toMatchObject({ messageId: 'prompt-open' });
    const frames = turn.steps.flatMap((step) => step.frames);
    const sameIdUserFrames = frames.filter(
      (frame) => frame.kind === 'text' && (frame as { frameId: string }).frameId === 'prompt-open',
    );
    expect(sameIdUserFrames).toHaveLength(0);
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

  it('seeds child interactions on both the owner and main transcript after owner backfill', () => {
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
    expect(store.getAgent('main')?.getInteraction('q-sub')?.state).toBe('pending');
    expect(store.getAgent('sub-1')?.getInteraction('q-sub')?.state).toBe('pending');

    interactions.respond('q-sub', { answers: {} });
    expect(store.getAgent('main')?.getInteraction('q-sub')?.state).toBe('answered');
    expect(store.getAgent('sub-1')?.getInteraction('q-sub')?.state).toBe('answered');
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
    expect([...byAgent.keys()].toSorted()).toEqual(['main', 'sub-1']);
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
    expect([...byAgent.keys()].toSorted()).toEqual(['main', 'sub-1']);
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
    expect(byAgent.get('main')?.map((op) => op.op)).toEqual(['interaction.upsert']);

    const sub = agents.add('sub-1');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    expect(byAgent.get('sub-1')!.length).toBeGreaterThan(1);
    binding.dispose();
  });

  it.each([1_000, 1_001])('materializes the first subagent spawn at %s and preserves its replayed terminal', (spawnedAt) => {
    const liveTx = new AgentTranscript('main');
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const wireTx = new AgentTranscript('main');
    const wireReducer = new TranscriptFactReducer(wireTx);
    const wireAdapter = new TranscriptWireAdapter('main', { task: (id) => wireTx.getTask(id) });
    const spawned = {
      type: 'subagent.spawned',
      subagentId: 'child-1',
      subagentName: 'worker',
      name: 'investigator',
      description: 'Inspect files',
      parentToolCallId: 'call-agent',
      runInBackground: true,
      taskId: 'task-1',
      time: spawnedAt,
    };
    const started = { type: 'subagent.started', subagentId: 'child-1', taskId: 'task-1', time: spawnedAt };
    const records = [
      {
        type: 'task.started',
        info: {
          taskId: 'task-1', kind: 'agent', agentId: 'child-1', status: 'running',
          profile: 'worker', collaborationTaskName: 'investigator',
          description: 'Inspect files', detached: true, startedAt: 1_000, endedAt: null,
        },
        time: 1_000,
      },
      spawned,
      started,
    ];
    for (const record of records) {
      liveTx.apply(liveAdapter.map(ev(record)));
      wireReducer.apply(wireAdapter.add(record as TranscriptWireRecord));
    }
    const expected = {
      taskId: 'task-1', kind: 'subagent', state: 'running', agentId: 'child-1',
      name: 'investigator', subagentName: 'worker', description: 'Inspect files', detached: true,
    };
    expect(liveTx.getTask('task-1')).toMatchObject(expected);
    expect(wireTx.getTask('task-1')).toMatchObject(expected);

    const completed = {
      type: 'subagent.completed', subagentId: 'child-1', taskId: 'task-1',
      resultSummary: 'Done', time: 2_000,
    };
    for (const record of [completed, spawned, started]) {
      wireReducer.apply(wireAdapter.add(record as TranscriptWireRecord));
    }
    expect(wireTx.getTask('task-1')).toMatchObject({ state: 'completed', resultSummary: 'Done' });
  });

  it.each([false, true])(
    'keeps task terminal after producer events across dual projection when recordRun is gated (failed=%s)',
    async (failed) => {
      const { createAgentToolContext, createAgentLifecycleStub } = await import('./helpers/agentToolFixture');
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => {
          if (failed) throw new Error('failed immediately');
          return { summary: 'finished immediately' };
        },
      });
      const ctx = createAgentToolContext(lifecycle);
      const captureTasks = ctx.get(IEventBus).subscribe((event) => {
        if (event.type.startsWith('task.')) lifecycle.publishedEvents.push(event);
      });
      onTestFinished(async () => {
        captureTasks.dispose();
        await ctx.dispose();
      });
      const tasks = ctx.get(IAgentTaskService);
      const gate = deferred<void>();
      const entered = deferred<void>();
      const dispatch = ctx.get(ISessionDispatchService);
      const recordRun = dispatch.recordRun.bind(dispatch);
      vi.spyOn(dispatch, 'recordRun').mockImplementation(async (agentId, taskId) => {
        await tasks.wait(taskId, 10);
        entered.resolve();
        await gate.promise;
        await recordRun(agentId, taskId);
      });

      const tool = ctx.get(IAgentToolRegistryService).resolve('AgentRun');
      expect(tool).toBeDefined();
      const pending = executeAgentTool(tool!, { prompt: 'Investigate', description: 'Find cause', background: true });
      await entered.promise;
      gate.resolve();
      const result = await pending;
      expect(result.isError).toBeFalsy();

      if (typeof result.output !== 'string') throw new TypeError('expected string output');
      const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
      expect(taskId).toBeDefined();

      await vi.waitFor(() => {
        expect(tasks.getTask(taskId!)?.status).toBe(failed ? 'failed' : 'completed');
        expect(lifecycle.publishedEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: failed ? 'subagent.failed' : 'subagent.completed', subagentId: 'agent-child', taskId,
          }),
          expect.objectContaining({ type: 'task.started', info: expect.objectContaining({ taskId }) }),
          expect.objectContaining({ type: 'task.terminated', info: expect.objectContaining({ taskId }) }),
        ]));
      });

      const decisive = lifecycle.publishedEvents
        .filter((event) => event.type.startsWith('subagent.'))
        .map((event) => event.type);
      expect.soft(decisive).toEqual(['subagent.spawned', 'subagent.started', failed ? 'subagent.failed' : 'subagent.completed']);

      const liveTx = new AgentTranscript('main');
      const liveAdapter = new AgentTranscriptLiveAdapter('main');
      const wireTx = new AgentTranscript('main');
      const wireReducer = new TranscriptFactReducer(wireTx);
      const wireAdapter = new TranscriptWireAdapter('main', {
        turn: (turnId) => wireTx.getTurn(turnId),
        task: (id) => wireTx.getTask(id),
      });
      for (const event of lifecycle.publishedEvents) {
        const record = { type: event.type, ...payloadOf(event) } as unknown as LiveAdapterBusEvent;
        void liveTx.apply(liveAdapter.map(record));
        wireReducer.apply(wireAdapter.add(record as unknown as TranscriptWireRecord));
      }
      expect.soft(liveTx.getTask(taskId!)?.state).toBe(failed ? 'failed' : 'completed');
      expect.soft(wireTx.getTask(taskId!)?.state).toBe(failed ? 'failed' : 'completed');
    },
  );
});

function payloadOf(event: Event2): Record<string, unknown> {
  const { type: _type, ...rest } = event as unknown as Record<string, unknown>;
  return rest;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function executeAgentTool(
  tool: NonNullable<ReturnType<IAgentToolRegistryService['resolve']>>,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; output?: unknown }> {
  const resolved = args['model_alias'] === undefined ? { ...args, model_alias: 'mock-model' } : args;
  const execution = await tool.resolveExecution(resolved as never);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_agent',
    signal: new AbortController().signal,
  } as never);
}
