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

import type { LiveAdapterBusEvent } from '@kiki/transcript-live';

import {
  TranscriptService,
  snapshotToOps,
  TRANSCRIPT_OPS_JOURNAL_CAPACITY,
} from '../../src/services/transcript/transcriptService';

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

describe('TranscriptService projection', () => {
  it('snapshotToOps anchors standalone items so backfill keeps history order against live turns', () => {
    const snapshot: AgentTranscriptSnapshot = {
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'one',
          steps: [],
        },
        { kind: 'marker', markerId: 'm1', marker: 'skill' },
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'two',
          steps: [],
        },
        { kind: 'taskref', refId: 'r1', taskId: 'bash-1' },
      ],
      tasks: [],
      meta: {},
    };
    const ops = snapshotToOps(snapshot);
    expect(ops.find((op) => op.op === 'marker.upsert')).toMatchObject({ beforeTurn: 1 });
    expect(ops.find((op) => op.op === 'taskref.upsert')).toMatchObject({ beforeTurn: 2 });

    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'user' } },
      },
    ]);
    tx.apply(ops);
    expect(
      tx.getItems().map((item) => {
        if (item.kind === 'turn') return item.turnId;
        if (item.kind === 'marker') return item.markerId;
        return item.refId;
      }),
    ).toEqual(['t0', 'm1', 't1', 'r1', 't2']);
  });

  it('snapshotToOps flattens attachment entities so backfilled attachmentIds never dangle', () => {
    const snapshot: AgentTranscriptSnapshot = {
      interactions: [],
      attachments: [
        {
          attachmentId: 'att_1',
          mediaType: 'image/*',
          name: 'shot.png',
          source: { kind: 'file', fileId: 'file_1' },
        },
      ],
      todos: [],
      prompts: [],
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'what is this?',
          attachmentIds: ['att_1'],
          steps: [],
        },
      ],
      tasks: [],
      meta: {},
    };

    const ops = snapshotToOps(snapshot);
    expect(ops.filter((op) => op.op === 'attachment.upsert')).toEqual([
      { op: 'attachment.upsert', attachment: snapshot.attachments[0] },
    ]);

    const tx = new AgentTranscript('main');
    tx.apply(ops);
    expect(tx.getAttachment('att_1')).toEqual(snapshot.attachments[0]);
    expect(turnOps('t0', tx.getItems()).attachmentIds).toEqual(['att_1']);
  });

  it('readColdSnapshot answers empty for path-hostile agent ids without touching disk', async () => {
    const service = new TranscriptService({
      homeDir: '/nonexistent-home',
      core: {
        accessor: {
          get: (token: unknown) => {
            if (token === ISessionManager) {
              return { get: () => undefined, list: () => [] };
            }
            if (token === IWorkspaceInstanceManager) {
              return { list: () => [], onDidChange: () => ({ dispose: () => undefined }) };
            }
            if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
            return undefined;
          },
        },
      } as unknown as Scope,
    });
    for (const hostile of ['../../main', '..', 'a/b', 'a\\b']) {
      const snapshot = await service.readColdSnapshot('s1', hostile);
      expect(snapshot?.items).toEqual([]);
    }
  });

  it('readColdSnapshot folds task/todo/goal/plan/interaction records into the cold snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-cold-facts-'));
    try {
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const records = [
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 1000,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'running' }],
            toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }],
          },
          time: 2000,
        },
        {
          type: 'tools.update_store',
          key: 'todo',
          value: [{ title: 'write tests', status: 'in_progress' }],
          time: 3000,
        },
        { type: 'goal.create', goalId: 'g1', objective: 'fix the bug', time: 4000 },
        { type: 'plan_mode.enter', id: 'plan-1', time: 5000 },
        {
          type: 'task.started',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'running',
            startedAt: 6000,
            endedAt: null,
          },
          time: 6000,
        },
        {
          type: 'task.terminated',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'completed',
            startedAt: 6000,
            endedAt: 9000,
          },
          outputTail: '42 passed',
          time: 9000,
        },
        {
          type: 'interaction.request',
          id: 'apr-1',
          kind: 'approval',
          toolCallId: 'call_1',
          request: { toolName: 'Bash' },
          time: 7000,
        },
        {
          type: 'interaction.resolved',
          id: 'apr-1',
          response: { decision: 'approved' },
          time: 8000,
        },
      ];
      await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

      const service = new TranscriptService({
        homeDir: home,
        core: {
          accessor: {
            get: (token: unknown) => {
              if (token === ISessionManager) return { get: () => undefined, list: () => [] };
              if (token === IWorkspaceInstanceManager) {
              return { list: () => [], onDidChange: () => ({ dispose: () => undefined }) };
            }
              if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
              return undefined;
            },
          },
        } as unknown as Scope,
      });
      const snapshot = await service.readColdSnapshot('s1', 'main');
      expect(snapshot).toBeDefined();

      expect(snapshot!.tasks).toEqual([
        {
          taskId: 'task_1',
          kind: 'shell',
          state: 'completed',
          detached: true,
          description: 'pnpm test',
          agentId: undefined,
          outputTail: '42 passed',
          startedAt: new Date(6000).toISOString(),
          endedAt: new Date(9000).toISOString(),
        },
      ]);
      expect(snapshot!.todos).toEqual([
        {
          todoId: 'todo',
          items: [{ title: 'write tests', status: 'in_progress' }],
          updatedAt: new Date(3000).toISOString(),
        },
      ]);
      expect(snapshot!.meta.goal).toMatchObject({ objective: 'fix the bug', status: 'active' });
      expect(snapshot!.meta.modes).toEqual({ plan: {} });
      expect(snapshot!.interactions).toEqual([
        {
          interactionId: 'apr-1',
          interactionKind: 'approval',
          toolCallId: 'call_1',
          origin: undefined,
          anchor: { kind: 'tool_call', toolCallId: 'call_1' },
          state: 'approved',
          request: { toolName: 'Bash' },
          response: { decision: 'approved' },
        },
      ]);

      const standalone = snapshot!.items.filter((item) => item.kind !== 'turn');
      expect(standalone).toEqual([
        expect.objectContaining({
          kind: 'marker',
          marker: 'goal',
          markerId: 'wire:v2:goal.create:g1',
        }),
        expect.objectContaining({
          kind: 'marker',
          marker: 'plan.enter',
          markerId: 'wire:v2:plan_mode.enter:plan-1',
        }),
        expect.objectContaining({ kind: 'taskref', refId: 'ref-task_1', taskId: 'task_1' }),
      ]);
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

describe('TranscriptService live integration', () => {
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

  const SHOT_PNG_UPLOAD = {
    type: 'image_url',
    imageUrl: { id: 'file_1' },
  };

  async function seedWireHome(
    attachment?: Record<string, unknown>,
    completed: boolean = attachment !== undefined,
  ): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'transcript-overlay-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const records: Record<string, unknown>[] = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input:
          attachment === undefined
            ? [{ type: 'text', text: 'hi' }]
            : [{ type: 'text', text: 'what is this?' }, attachment],
        origin: { kind: 'user' },
        time: 1_000,
      },
    ];
    if (completed) {
      records.push({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 });
    }
    await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return home;
  }

  function fakeCoreWithAgents(interactions: SessionInteractionService, agents: FakeAgents): Scope {
    const sessionLifecycle = {
      onDidCloseSession: () => ({ dispose: () => undefined }),
      onDidArchiveSession: () => ({ dispose: () => undefined }),
      get: (sid: string) => (sid === 's1' ? fakeSession(interactions, agents) : undefined),
    };
    const handler = {
      id: 'ws',
      kind: 'program',
      accessor: {
        get: (t: unknown) => (t === ISessionLifecycleService ? sessionLifecycle : undefined),
      },
      dispose: () => undefined,
    };
    return {
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionManager) {
            return { get: sessionLifecycle.get, list: () => [sessionLifecycle.get('s1')] };
          }
          if (token === IWorkspaceInstanceManager) {
            return {
              list: () => [{ program: { accessor: handler.accessor } }],
              onDidChange: () => ({ dispose: () => undefined }),
            };
          }
          if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
          return undefined;
        },
      },
    } as unknown as Scope;
  }

  async function seedWireHomeWithTool(includeResult: boolean = true): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'transcript-backfill-live-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const records: Record<string, unknown>[] = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'hi' }],
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
          part: { type: 'text', text: 'Hello ' },
        },
        time: 3_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-tool-1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'ls' },
        },
        time: 4_000,
      },
    ];
    if (includeResult) {
      records.push({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'call_1',
          result: { output: 'a.txt', isError: false },
        },
        time: 5_000,
      });
    }
    await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return home;
  }

  async function seedWireHomeWithRunningSubagentTask(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'transcript-backfill-task-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const record = {
      type: 'task.started',
      info: {
        taskId: 'task-9',
        kind: 'agent',
        agentId: 'agent-1',
        description: 'Inspect',
        status: 'running',
        detached: true,
        startedAt: 1_000,
        endedAt: null,
      },
      time: 1_000,
    };
    await writeFile(join(wireDir, 'wire.jsonl'), `${JSON.stringify(record)}\n`);
    return home;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('flattens interactions, todos and prompts in snapshotToOps', () => {
    const ops = snapshotToOps({
      items: [],
      tasks: [],
      interactions: [
        { interactionId: 'apr-1', interactionKind: 'approval', state: 'approved' },
      ],
      attachments: [],
      todos: [{ todoId: 'todo', items: [{ title: 'x', status: 'done' }] }],
      prompts: [
        { promptId: 'p1', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      meta: {},
    });
    expect(ops.map((op) => op.op)).toEqual([
      'interaction.upsert',
      'todo.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('preserves the full in-flight turn and closes it at the real live end time', async () => {
    const home = await seedWireHomeWithTool(false);
    try {
      const agents = new FakeAgents();
      const loopStatus = { state: 'running', activeTurnId: 0 };
      const main = agents.add('main', { loopStatus });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      const observedStates: string[] = [];
      service.onSessionOps('s1', (event) => {
        for (const op of event.ops) {
          if (op.op === 'turn.upsert' && op.turn.turnId === 't0') observedStates.push(op.turn.state);
        }
      });
      await service.whenReady('s1');

      const running = store?.getAgent('main')?.getTurn('t0');
      const runningTool = running?.steps[0]?.frames.find((frame) => frame.kind === 'tool');
      expect(running).toMatchObject({ state: 'running', prompt: 'hi' });
      expect(running?.steps[0]).toMatchObject({ state: 'running' });
      expect(running?.steps[0]?.endedAt).toBeUndefined();
      expect(runningTool).toMatchObject({
        state: 'running',
        startedAt: new Date(4_000).toISOString(),
      });
      expect(runningTool?.endedAt).toBeUndefined();
      expect(observedStates).toContain('running');
      expect(observedStates).not.toContain('cancelled');

      loopStatus.state = 'idle';
      main.bus.emit(ev({ type: 'turn.ended', time: 9_000, turnId: 0, reason: 'completed' }));
      const completed = store?.getAgent('main')?.getTurn('t0');
      expect(completed).toMatchObject({ state: 'completed', endedAt: new Date(9_000).toISOString() });
      expect(completed?.steps[0]).toMatchObject({
        state: 'interrupted',
        endedAt: new Date(9_000).toISOString(),
      });
      expect(completed?.steps[0]?.frames.find((frame) => frame.kind === 'tool')).toMatchObject({
        state: 'interrupted',
        endedAt: new Date(9_000).toISOString(),
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('preserves the initially active turn when it ends during the async backfill read', async () => {
    const home = await seedWireHomeWithTool(false);
    try {
      const agents = new FakeAgents();
      const loopStatus: { state: string; activeTurnId?: number } = {
        state: 'running',
        activeTurnId: 0,
      };
      const main = agents.add('main', { loopStatus });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      loopStatus.state = 'idle';
      main.bus.emit(ev({ type: 'turn.ended', time: 9_000, turnId: 0, reason: 'completed' }));

      await service.whenReady('s1');
      const turn = store?.getAgent('main')?.getTurn('t0');
      expect(turn).toMatchObject({ state: 'completed', endedAt: new Date(9_000).toISOString() });
      expect(turn?.steps[0]).toMatchObject({
        state: 'interrupted',
        endedAt: new Date(9_000).toISOString(),
      });
      expect(turn?.steps[0]?.frames.find((frame) => frame.kind === 'tool')).toMatchObject({
        state: 'interrupted',
        endedAt: new Date(9_000).toISOString(),
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('uses the active turn sampled after the async backfill read when a turn starts mid-read', async () => {
    const home = await seedWireHome();
    try {
      const agents = new FakeAgents();
      const loopStatus: { state: string; activeTurnId?: number } = { state: 'idle' };
      const main = agents.add('main', { loopStatus });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      loopStatus.state = 'running';
      loopStatus.activeTurnId = 1;
      main.bus.emit(ev({ type: 'turn.started', time: 6_000, turnId: 1, origin: { kind: 'user' } }));

      await service.whenReady('s1');
      expect(store?.getAgent('main')?.getTurn('t0')).toMatchObject({ state: 'cancelled' });
      expect(store?.getAgent('main')?.getTurn('t1')).toMatchObject({ state: 'running' });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('omits a cold uncertain subagent task without overwriting live terminal evidence', async () => {
    const home = await seedWireHomeWithRunningSubagentTask();
    try {
      const liveTask = {
        taskId: 'task-9',
        kind: 'agent',
        agentId: 'agent-1',
        description: 'Inspect',
        status: 'running',
        detached: true,
        startedAt: 1_000,
        endedAt: null as number | null,
      };
      const agents = new FakeAgents();
      agents.add('main', { tasks: [liveTask] });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      expect((await service.readColdSnapshot('s1', 'main'))?.tasks).toEqual([]);
      const store = service.forSessionLive('s1');
      liveTask.status = 'killed';
      liveTask.endedAt = 2_000;
      agents.get('main')!.bus.emit(
        ev({ type: 'task.terminated', info: { ...liveTask, stopReason: 'cancelled' } }),
      );

      await service.whenReady('s1');
      expect(store?.getAgent('main')?.getTask('task-9')).toMatchObject({
        state: 'killed',
        endedAt: new Date(2_000).toISOString(),
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('deduplicates durable events captured by both cold backfill and the live replay buffer', async () => {
    const home = await seedWireHomeWithTool(false);
    try {
      const agents = new FakeAgents();
      const main = agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const originalReadColdSnapshot = service.readColdSnapshot.bind(service);
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      vi.spyOn(service, 'readColdSnapshot').mockImplementation(async (...args) => {
        await readGate;
        return originalReadColdSnapshot(...args);
      });

      const store = service.forSessionLive('s1')!;
      const taskStates: TranscriptTask['state'][] = [];
      service.onSessionOps('s1', (event) => {
        for (const op of event.ops) {
          if (op.op === 'task.upsert' && op.task.taskId === 'task-9') taskStates.push(op.task.state);
        }
      });
      main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }));
      main.bus.emit(ev({ type: 'turn.step.started', turnId: 0, step: 1, stepId: 'step-1' }));
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const overlap = [
        {
          type: 'subagent.spawned',
          time: 6_000,
          subagentId: 'agent-1',
          subagentName: 'explore',
          parentToolCallId: 'call_1',
          description: 'Inspect',
          runInBackground: true,
          taskId: 'task-9',
        },
        {
          type: 'subagent.completed',
          time: 7_000,
          subagentId: 'agent-1',
          resultSummary: 'done',
        },
        {
          type: 'task.notified',
          time: 8_000,
          notificationType: 'completed',
          title: 'Agent completed',
          body: 'done',
          severity: 'info',
          sourceKind: 'agent',
          sourceId: 'task-9',
        },
      ];
      for (const event of overlap) {
        await appendFile(wirePath, `${JSON.stringify(event)}\n`);
        main.bus.emit(ev(event));
      }
      releaseRead();

      await service.whenReady('s1');
      const turn = store.getAgent('main')?.getTurn('t0');
      const notificationFrames = turn?.steps
        .flatMap((step) => step.frames)
        .filter((frame) => frame.kind === 'text' && frame.taskId === 'task-9');
      const tool = turn?.steps
        .flatMap((step) => step.frames)
        .find((frame) => frame.kind === 'tool' && frame.toolCallId === 'call_1');
      expect(notificationFrames).toEqual([
        expect.objectContaining({ frameId: 'task-notified:task-9', text: 'Agent completed\ndone' }),
      ]);
      expect(tool).toMatchObject({ agentRefs: [{ agentId: 'agent-1', role: 'child' }] });
      expect(taskStates).toEqual(['completed']);
      expect(store.getAgent('main')?.getTask('task-9')).toMatchObject({
        state: 'completed',
        detached: true,
        description: 'Inspect',
        startedAt: new Date(6_000).toISOString(),
        endedAt: new Date(7_000).toISOString(),
        resultSummary: 'done',
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('merges the backfill live-first: live frame fields and longer text survive', async () => {
    const home = await seedWireHomeWithTool();
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      const bus = agents.get('main')!.bus;
      bus.emit(
        ev({
          type: 'turn.started',
          turnId: 0,
          origin: { kind: 'user' },
          prompt: 'hi',
          promptId: 'prompt-1',
        }),
      );
      bus.emit(ev({ type: 'turn.step.started', turnId: 0, step: 1, stepId: 'step-1' }));
      bus.emit(
        ev({
          type: 'assistant.delta',
          turnId: 0,
          step: 1,
          stepId: 'step-1',
          partId: 'part-1',
          delta: 'world',
        }),
      );
      bus.emit(
        ev({
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'ls' },
          display: { kind: 'command', command: 'ls' },
        }),
      );
      bus.emit(ev({ type: 'tool.result', toolCallId: 'call_1', output: 'a.txt' }));
      await service.whenReady('s1');

      expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(1);
      const turn = store?.getAgent('main')?.getTurn('t0');
      expect(turn?.state).toBe('running');
      const text = turn?.steps[0]?.frames.find((f) => f.kind === 'text');
      expect(text).toMatchObject({ text: 'Hello world' });
      const tool = turn?.steps[0]?.frames.find((f) => f.kind === 'tool');
      expect(tool).toMatchObject({
        state: 'done',
        output: 'a.txt',
        display: { kind: 'command', command: 'ls' },
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('tracks tool-call count decreases when history rewrites remove frames and turns', async () => {
    const agents = new FakeAgents();
    agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
    const service = new TranscriptService({
      homeDir: '/nonexistent-home',
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    const store = service.forSessionLive('s1');
    await service.whenReady('s1');
    const bus = agents.get('main')!.bus;
    bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }));
    bus.emit(ev({ type: 'turn.step.started', turnId: 0, step: 1, stepId: 'step-1' }));
    for (let index = 1; index <= 5; index += 1) {
      bus.emit(
        ev({
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: `call_${index}`,
          name: 'Read',
          args: { path: `file-${index}.txt` },
        }),
      );
    }

    expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(5);
    const transcript = store?.getAgent('main');
    if (transcript === undefined) throw new Error('expected materialized main transcript');
    const snapshot = transcript.snapshot();
    const rewritten: AgentTranscriptSnapshot = {
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.kind === 'turn'
          ? {
              ...item,
              steps: item.steps.map((step) => ({
                ...step,
                frames: step.frames.filter(
                  (frame) =>
                    frame.kind !== 'tool' ||
                    frame.toolCallId === 'call_1' ||
                    frame.toolCallId === 'call_2',
                ),
              })),
            }
          : item,
      ),
    };
    const readColdSnapshot = vi.spyOn(service, 'readColdSnapshot');
    readColdSnapshot.mockResolvedValueOnce(rewritten);
    await service.reconcileAfterRewrite('s1');
    expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(2);

    readColdSnapshot.mockResolvedValueOnce({ ...rewritten, items: [] });
    await service.reconcileAfterRewrite('s1');
    expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(0);
    service.dropSession('s1');
  });

  it('re-asserts running when the backfill rebuilds the live turn completed', async () => {
    const home = await seedWireHome(undefined, true);
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      agents
        .get('main')!
        .bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'live hi' }));
      await service.whenReady('s1');
      expect(store?.getAgent('main')?.getTurn('t0')).toMatchObject({
        state: 'running',
        prompt: 'hi',
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('backfill + overlay keep the durable prompt and canonical attachment ids', async () => {
    const home = await seedWireHome(SHOT_PNG_UPLOAD);
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      agents.get('main')!.bus.emit(
        ev({
          type: 'turn.started',
          turnId: 0,
          origin: { kind: 'user' },
          prompt: 'live prompt',
          promptAttachments: [{ kind: 'image', fileId: 'file_1' }],
        }),
      );
      await service.whenReady('s1');

      const agent = store?.getAgent('main');
      expect(agent?.getTurn('t0')).toMatchObject({
        state: 'running',
        prompt: 'what is this?',
        attachmentIds: ['t0.att1'],
      });
      expect(agent?.getAttachment('t0.att1')).toBeDefined();
      expect(agent?.getAttachment('att_1')).toBeUndefined();
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('durable turn completion preserves canonical attachment ids directly', async () => {
    const home = await seedWireHome(SHOT_PNG_UPLOAD);
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'idle' } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1');
      const batches: TranscriptOperation[][] = [];
      service.onSessionOps('s1', (event) => {
        if (event.agentId === 'main') batches.push([...event.ops]);
      });
      const bus = agents.get('main')!.bus;
      bus.emit(
        ev({
          type: 'turn.started',
          turnId: 0,
          origin: { kind: 'user' },
          prompt: 'live prompt',
          promptAttachments: [{ kind: 'image', fileId: 'file_1' }],
        }),
      );
      await service.whenReady('s1');

      bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
      await waitFor(() =>
        batches.some((batch) =>
          batch.some(
            (op) => op.op === 'turn.upsert' && op.turn.state === 'completed',
          ),
        ),
      );
      const terminalBatch = batches.findLast((batch) =>
        batch.some((op) => op.op === 'turn.upsert' && op.turn.state === 'completed'),
      )!;
      expect(terminalBatch.find((op) => op.op === 'turn.upsert')).toMatchObject({
        turn: { attachmentIds: ['t0.att1'] },
      });
      const attachmentUpserts = batches.flatMap((batch) =>
        batch.filter((op) => op.op === 'attachment.upsert'),
      );
      expect(attachmentUpserts).toEqual([
        { op: 'attachment.upsert', attachment: expect.objectContaining({ attachmentId: 't0.att1' }) },
      ]);

      const agent = store?.getAgent('main');
      expect(agent?.getTurn('t0')).toMatchObject({
        state: 'completed',
        attachmentIds: ['t0.att1'],
      });
      expect(agent?.getAttachment('t0.att1')).toBeDefined();
      expect(agent?.getAttachment('att_1')).toBeUndefined();
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  describe('op journal', () => {
    it('assigns consecutive per-agent seqs and serves catch-up from the journal', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');

      const seen: number[] = [];
      service.onSessionOps('s1', (_event, cursor) => seen.push(cursor.seq));
      main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      main.bus.emit(
        ev({ type: 'turn.ended', time: 1_700_000_000_000, turnId: 0, reason: 'completed' }),
      );

      expect(seen).toEqual([base + 1, base + 2]);
      expect(service.getSeqWatermark('s1', 'main')).toBe(base + 2);

      const catchup = service.getOpsSince('s1', 'main', base);
      expect(catchup?.complete).toBe(true);
      expect(catchup?.throughSeq).toBe(base + 2);
      expect(catchup?.batches.map((batch) => batch.seq)).toEqual([base + 1, base + 2]);

      expect(service.getOpsSince('s1', 'main', base + 2)).toMatchObject({
        batches: [],
        throughSeq: base + 2,
        complete: true,
      });
      expect(service.getOpsSince('s1', 'main', base + 3)?.complete).toBe(false);

      const sub = agents.add('sub-1');
      sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      expect(service.getSeqWatermark('s1', 'sub-1')).toBe(1);
      expect(service.getOpsSince('s1', 'sub-1', 0)?.batches.map((batch) => batch.seq)).toEqual([1]);

      expect(service.getSeqWatermark('s1', 'nope')).toBe(0);
      expect(service.getOpsSince('nope-session', 'main', base)).toBeUndefined();
      service.dropSession('s1');
    });

    it('does not journal or publish a structurally equal taskref replay', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1')!;
      const info = {
        taskId: 'task-1',
        kind: 'process',
        description: 'build',
        status: 'running',
        detached: true,
        startedAt: 1_000,
        endedAt: null,
      };
      await service.whenReady('s1');
      main.bus.emit(ev({ type: 'task.started', id: 'fact-1', info, time: 1_000 }));

      const taskref = store
        .getAgent('main')
        ?.getItems()
        .find((item) => item.kind === 'taskref' && item.refId === 'ref-task-1');
      const cursor = service.getTranscriptCursor('s1', 'main');
      let notifications = 0;
      service.onSessionOps('s1', () => {
        notifications += 1;
      });

      main.bus.emit(ev({ type: 'task.started', id: 'fact-2', info: { ...info }, time: 1_000 }));

      expect(service.getTranscriptCursor('s1', 'main')).toEqual(cursor);
      expect(store.getAgent('main')?.getItems().find((item) => item.kind === 'taskref')).toBe(taskref);
      expect(notifications).toBe(0);
      expect(service.getOpsSince('s1', 'main', cursor)?.batches).toEqual([]);
      service.dropSession('s1');
    });

    it('starts a fresh epoch after the live transcript store is rebuilt', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      const oldCursor = service.getTranscriptCursor('s1', 'main');

      service.dropSession('s1');
      service.forSessionLive('s1');
      await service.whenReady('s1');
      main.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      const currentCursor = service.getTranscriptCursor('s1', 'main');

      expect(currentCursor.seq).toBe(oldCursor.seq);
      expect(currentCursor.epoch).not.toBe(oldCursor.epoch);
      expect(service.getOpsSince('s1', 'main', oldCursor)).toMatchObject({
        batches: [],
        throughSeq: currentCursor.seq,
        complete: false,
      });
      expect(service.getOpsSince('s1', 'main', { epoch: currentCursor.epoch, seq: 0 })?.complete).toBe(true);
      service.dropSession('s1');
    });

    it('resets the transcript store and starts a new epoch after a history rewrite', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      const oldCursor = service.getTranscriptCursor('s1', 'main');
      const rewritten: AgentTranscriptSnapshot = {
        items: [
          {
            kind: 'turn',
            turnId: 't0',
            ordinal: 0,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'rewritten',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: false,
      };
      service.readColdSnapshot = async () => rewritten;

      await service.reconcileAfterRewrite('s1', 'main');

      const currentCursor = service.getTranscriptCursor('s1', 'main');
      expect(currentCursor).toMatchObject({ seq: 0 });
      expect(currentCursor.epoch).not.toBe(oldCursor.epoch);
      expect(store.getAgent('main')?.snapshot()).toEqual(rewritten);
      expect(service.getOpsSince('s1', 'main', oldCursor)).toMatchObject({
        batches: [],
        throughSeq: 0,
        complete: false,
      });
      service.dropSession('s1');
    });

    it('marks catch-up incomplete once the bounded journal evicts old batches', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');

      for (let turnId = 1; turnId <= TRANSCRIPT_OPS_JOURNAL_CAPACITY + 1; turnId++) {
        main.bus.emit(ev({ type: 'turn.started', turnId, origin: { kind: 'user' } }));
      }
      const watermark = service.getSeqWatermark('s1', 'main');
      expect(watermark).toBe(base + TRANSCRIPT_OPS_JOURNAL_CAPACITY + 1);

      const evicted = service.getOpsSince('s1', 'main', base);
      expect(evicted?.complete).toBe(false);
      expect(evicted?.throughSeq).toBe(watermark);
      expect(evicted?.batches).toHaveLength(TRANSCRIPT_OPS_JOURNAL_CAPACITY);

      const recent = service.getOpsSince('s1', 'main', watermark - 10);
      expect(recent?.complete).toBe(true);
      expect(recent?.batches.map((batch) => batch.seq)).toEqual(
        Array.from({ length: 10 }, (_, i) => watermark - 9 + i),
      );
      service.dropSession('s1');
    });
  });
});
