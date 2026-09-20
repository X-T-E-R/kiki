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
} from '@kiki/agent-core-v2';
import { projectAgentTranscriptView } from '@kiki/session-core/session/transcript/project';
import { createViewState } from '@kiki/session-core/session/transcript/types';
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
} from '@kiki/transcript';
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
});
