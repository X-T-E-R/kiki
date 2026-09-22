import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
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
  IQueryStore,
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
  type TranscriptChangeEvent,
  type TranscriptFrame,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTurn,
} from '@kiki/transcript';
import { describe, expect, it, vi } from 'vitest';

import { streamWireRecords, type LiveAdapterBusEvent } from '@kiki/transcript-live';

import {
  TranscriptService,
  type TranscriptServiceDeps,
  snapshotToOps,
  TRANSCRIPT_OPS_JOURNAL_CAPACITY,
} from '../../src/services/transcript/transcriptService';
import {
  DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
  TranscriptMemoryConfigSchema,
} from '../../src/services/transcript/configSection';
import { readWireRecordsBounded } from '../../src/services/transcript/boundedWireScan';
import { registerTranscriptRoutes } from '../../src/routes/transcript';

vi.mock('node:fs/promises', { spy: true });

function ev(payload: Record<string, unknown>): LiveAdapterBusEvent {
  return payload as unknown as LiveAdapterBusEvent;
}

function measuredReader(metrics: { reads: number; bytes: number }): NonNullable<
  TranscriptServiceDeps['toolCallCountReader']
> {
  return async (wirePath, fileSize, options) =>
    readWireRecordsBounded(wirePath, fileSize, {
      ...options,
      onRead: (bytes) => {
        metrics.reads += 1;
        metrics.bytes += bytes;
        options.onRead?.(bytes);
      },
    });
}

class TestSessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

function coldCore(): Scope {
  return {
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
  } as unknown as Scope;
}

function turnOps(turnId: string, items: ReturnType<AgentTranscript['getItems']>): TranscriptTurn {
  const turn = items.find(
    (item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId,
  );
  if (turn === undefined) throw new Error(`turn ${turnId} not found`);
  return turn;
}

describe('transcript memory config', () => {
  it('exposes only the resident limits consumed by TranscriptService', () => {
    expect(DEFAULT_TRANSCRIPT_MEMORY_CONFIG).toEqual({
      tailTurns: 20,
      maxAgentBytes: 16 << 20,
    });
    expect(TranscriptMemoryConfigSchema.parse(DEFAULT_TRANSCRIPT_MEMORY_CONFIG)).toEqual(
      DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
    );
    for (const field of [
      'maxSessionBytes',
      'maxTotalBytes',
      'opsMaxBatches',
      'opsMaxAgentBytes',
      'opsMaxSessionBytes',
      'opsMaxTotalBytes',
    ]) {
      expect(
        TranscriptMemoryConfigSchema.safeParse({
          ...DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
          [field]: 1,
        }).success,
      ).toBe(false);
    }
  });
});

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
    const queryValues = new Map<string, unknown>();
    const queryStore = {
      get: async <T>(collection: string, key: string) => queryValues.get(`${collection}\0${key}`) as T | undefined,
      put: async <T>(collection: string, key: string, value: T) => {
        queryValues.set(`${collection}\0${key}`, structuredClone(value));
      },
      delete: async (collection: string, key: string) => {
        queryValues.delete(`${collection}\0${key}`);
      },
    } as unknown as IQueryStore;
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
          if (token === IQueryStore) return queryStore;
          return undefined;
        },
      },
    } as unknown as Scope;
  }

  it('reads cached historical counts without materializing transcripts and distinguishes missing history', async () => {
    const home = await seedWireHomeWithTool();
    try {
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
      });
      const materialize = vi.spyOn(service, 'readColdSnapshot');
      expect((await service.getAgentToolCallCounts('s1', ['main', 'agent-missing'])).get('main')).toBe(1);
      expect((await service.getAgentToolCallCounts('s1', ['agent-missing'])).has('agent-missing')).toBe(false);
      expect(materialize).not.toHaveBeenCalled();
      const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const resumed = [
        { type: 'turn.prompt', turnId: 1, promptId: 'prompt-2', input: [], origin: { kind: 'user' }, time: 6_000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 'step-2' }, time: 7_000 },
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 'step-2', toolCallId: 'call_2', name: 'Read', args: {} }, time: 8_000 },
      ];
      await appendFile(path, `${resumed.map((record) => JSON.stringify(record)).join('\n')}\n`);
      expect((await service.getAgentToolCallCounts('s1', ['main', 'main'])).get('main')).toBe(2);
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(2);
      await appendFile(path, `${JSON.stringify({ type: 'context.undo', count: 1, time: 9_000 })}\n`);
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(1);
      await appendFile(path, `${JSON.stringify({ type: 'context.clear', time: 10_000 })}\n`);
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(0);
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] pins requested cache hits so a 257-file working set rereads at most one file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-count-cache-'));
    try {
      const agentIds = Array.from({ length: 257 }, (_, index) => `agent-${index}`);
      const wireSizes = new Map<string, number>();
      for (const agentId of agentIds) {
        const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', agentId);
        await mkdir(wireDir, { recursive: true });
        const record = {
          type: 'turn.prompt',
          turnId: 0,
          promptId: `${agentId}-prompt`,
          input: [],
          origin: { kind: 'user' },
        };
        const wire = `${JSON.stringify(record)}\n`;
        wireSizes.set(agentId, Buffer.byteLength(wire));
        await writeFile(join(wireDir, 'wire.jsonl'), wire);
      }
      const metrics = { reads: 0, bytes: 0 };
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        toolCallCountLimits: {
          maxBytesPerRequest: 1 << 20,
          maxFilesPerRequest: 300,
          maxCacheEntries: 256,
          maxCacheBytes: 1 << 20,
        },
        toolCallCountReader: measuredReader(metrics),
      });
      const first = await service.getAgentToolCallCounts('s1', agentIds);
      const firstReads = metrics.reads;
      const firstBytes = metrics.bytes;
      metrics.reads = 0;
      metrics.bytes = 0;
      const second = await service.getAgentToolCallCounts('s1', agentIds);
      expect(first.size).toBe(257);
      expect(second.size).toBe(257);
      expect(firstReads).toBe(257);
      expect(firstBytes).toBe([...wireSizes.values()].reduce((sum, size) => sum + size, 0));
      expect(metrics.reads).toBe(1);
      expect(metrics.bytes).toBe(wireSizes.get('agent-0'));
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] does not reread a large wire after the live transcript becomes complete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-count-materialized-'));
    try {
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const records = Array.from({ length: 3_000 }, (_, index) => ({
        type: 'metadata',
        index,
        padding: 'x'.repeat(700),
      }));
      const wirePath = join(wireDir, 'wire.jsonl');
      await writeFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'idle' } });
      const metrics = { reads: 0, bytes: 0 };
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        toolCallCountReader: measuredReader(metrics),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const before = await service.getAgentToolCallCounts('s1', ['main']);
      expect(before.get('main')).toBe(0);
      expect(metrics.reads).toBe(0);
      metrics.reads = 0;
      metrics.bytes = 0;
      await appendFile(wirePath, `${JSON.stringify({ type: 'metadata', padding: 'y'.repeat(700) })}\n`);
      const bus = agents.get('main')!.bus;
      bus.emit(ev({ type: 'turn.started', turnId: 3_001, origin: { kind: 'user' } }));
      bus.emit(ev({ type: 'turn.step.started', turnId: 3_001, step: 1 }));
      bus.emit(
        ev({
          type: 'tool.call.started',
          turnId: 3_001,
          toolCallId: 'call-live',
          name: 'Read',
          args: {},
        }),
      );
      const readFile = vi.spyOn(fsPromises, 'readFile').mockClear();
      const open = vi.spyOn(fsPromises, 'open').mockClear();
      try {
        const after = await service.getAgentToolCallCounts('s1', ['main']);
        expect(after.get('main')).toBe(1);
        expect(metrics.reads).toBe(0);
        expect(metrics.bytes).toBe(0);
        expect(readFile).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        readFile.mockRestore();
        open.mockRestore();
      }
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] counts tool calls for wires beyond the old 1 MiB default budget', async () => {
    const home = await seedWireHomeWithTool();
    try {
      await appendFile(
        join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl'),
        `${JSON.stringify({ type: 'metadata', padding: 'z'.repeat(2 << 20) })}\n`,
      );
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
      });
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] returns unknown instead of using a stale count after a wire exceeds the byte budget', async () => {
    const home = await seedWireHomeWithTool();
    try {
      const metrics = { reads: 0, bytes: 0 };
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        toolCallCountLimits: { maxBytesPerRequest: 2_048, maxFilesPerRequest: 8 },
        toolCallCountReader: measuredReader(metrics),
      });
      const first = await service.getAgentToolCallCounts('s1', ['main']);
      expect(first.get('main')).toBe(1);
      metrics.reads = 0;
      metrics.bytes = 0;
      await appendFile(
        join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl'),
        `${JSON.stringify({ type: 'metadata', padding: 'z'.repeat(4_096) })}\n`,
      );
      const second = await service.getAgentToolCallCounts('s1', ['main']);
      expect(second.has('main')).toBe(false);
      expect(metrics.reads).toBe(0);
      expect(metrics.bytes).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R3] verifies readability even for a zero-byte bounded scan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-empty-read-'));
    try {
      await expect(readWireRecordsBounded(join(home, 'missing.jsonl'), 0, {
        maxBytes: 0,
        onRecord: () => undefined,
      })).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it.each(['tool-prefix', 'half-record', 'complete-no-newline'] as const)(
    '[STAT-R3] preserves prefix display without promoting incomplete %s history', async (scenario) => {
      const home = await seedWireHomeWithTool();
      try {
        const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
        const wire = await fsPromises.readFile(wirePath, 'utf8');
        const content = scenario === 'half-record' ? '{"type":'
          : scenario === 'tool-prefix' ? `${wire}{"type":` : wire.trimEnd();
        await writeFile(wirePath, content);
        const agents = new FakeAgents();
        agents.add('main', { loopStatus: { state: 'idle' } });
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        });
        const known = scenario === 'complete-no-newline';
        expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(known ? 1 : undefined);
        const cold = await service.readColdSnapshot('s1', 'main');
        expect(cold?.toolCallCountKnown).toBe(known);
        expect(cold?.toolCallCount).toBe(known ? 1 : undefined);
        expect(cold?.items.some((item) => item.kind === 'turn')).toBe(scenario !== 'half-record');
        const store = service.forSessionLive('s1');
        await service.whenReady('s1');
        await service.ensureAgentHistory('s1', 'main');
        const live = store?.getAgent('main')?.snapshot();
        expect(live?.toolCallCountKnown).toBe(known);
        expect(live?.toolCallCount).toBe(known ? 1 : undefined);
        expect(live?.items.some((item) => item.kind === 'turn')).toBe(scenario !== 'half-record');
        expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(known ? 1 : undefined);
        expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(known ? 1 : undefined);
        service.dropSession('s1');
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  );

  it('[STAT-R3] keeps missing and corrupt history unknown while preserving readable empty as zero', async () => {
    const scenarios = [
      { name: 'missing', content: undefined, expectedKnown: false },
      { name: 'corrupt', content: '{"type":"turn.prompt"}\nnot-json\n', expectedKnown: false },
      { name: 'empty', content: '', expectedKnown: true },
    ] as const;
    for (const scenario of scenarios) {
      const home = await mkdtemp(join(tmpdir(), `transcript-count-${scenario.name}-`));
      try {
        const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
        await mkdir(wireDir, { recursive: true });
        const wirePath = join(wireDir, 'wire.jsonl');
        if (scenario.content !== undefined) await writeFile(wirePath, scenario.content);
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(
            new SessionInteractionService(new TestSessionStateService()),
            new FakeAgents(),
          ),
        });
        const snapshot = await service.readColdSnapshot('s1', 'main');
        expect(snapshot?.toolCallCountKnown).toBe(scenario.expectedKnown);
        if (scenario.expectedKnown) {
          expect(snapshot?.toolCallCount).toBe(0);
          expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(0);
        } else {
          expect(snapshot?.toolCallCount).toBeUndefined();
          expect((await service.getAgentToolCallCounts('s1', ['main'])).has('main')).toBe(false);
        }
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
  });

  it('[STAT-R3] retries a failed child backfill only after readable wire evidence appears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-backfill-recovery-'));
    try {
      const agents = new FakeAgents();
      agents.add('main');
      agents.add('child-recovery');
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      await service.ensureAgentHistory('s1', 'child-recovery');
      expect(service.getMaterializedAgentToolCallCounts('s1', ['child-recovery'])).toEqual(new Map());
      const readColdSnapshot = vi.spyOn(service, 'readColdSnapshot');
      await service.ensureAgentHistory('s1', 'child-recovery');
      expect(readColdSnapshot).not.toHaveBeenCalled();

      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'child-recovery');
      await mkdir(wireDir, { recursive: true });
      const records = [
        {
          type: 'turn.prompt',
          turnId: 0,
          promptId: 'recovery-prompt',
          input: [],
          origin: { kind: 'user' },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'recovery-step' },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            turnId: 0,
            stepUuid: 'recovery-step',
            toolCallId: 'recovery-call',
            name: 'Read',
            args: {},
          },
        },
      ];
      await writeFile(
        join(wireDir, 'wire.jsonl'),
        `${records.map((record) => JSON.stringify(record)).join(String.fromCodePoint(10))}${String.fromCodePoint(10)}`,
      );
      await service.ensureAgentHistory('s1', 'child-recovery');
      expect(service.getMaterializedAgentToolCallCounts('s1', ['child-recovery']).get('child-recovery')).toBe(1);
      expect(readColdSnapshot).toHaveBeenCalledOnce();
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R3] dispatches authoritative known and unknown count operations to live clients', async () => {
    const knownHome = await seedWireHomeWithTool();
    try {
      const knownAgents = new FakeAgents();
      const knownMain = knownAgents.add('main', { loopStatus: { state: 'idle' } });
      const knownService = new TranscriptService({
        homeDir: knownHome,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), knownAgents),
      });
      const knownEvents: TranscriptChangeEvent[] = [];
      knownService.onSessionOps('s1', (event) => knownEvents.push(event));
      await knownService.whenReady('s1');
      expect(knownEvents.flatMap((event) => event.ops)).toContainEqual({
        op: 'tool.count.set',
        count: 1,
      });
      knownMain.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      knownMain.bus.emit(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
      knownMain.bus.emit(
        ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call-2', name: 'Read', args: {} }),
      );
      expect(knownEvents.at(-1)?.ops.at(-1)).toEqual({ op: 'tool.count.set', count: 2 });
      knownService.dropSession('s1');
    } finally {
      await rm(knownHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }

    const unknownAgents = new FakeAgents();
    const unknownMain = unknownAgents.add('main', { loopStatus: { state: 'idle' } });
    const unknownService = new TranscriptService({
      homeDir: '/nonexistent-home',
      core: fakeCoreWithAgents(
        new SessionInteractionService(new TestSessionStateService()),
        unknownAgents,
      ),
    });
    const unknownEvents: TranscriptChangeEvent[] = [];
    unknownService.onSessionOps('s1', (event) => unknownEvents.push(event));
    await unknownService.whenReady('s1');
    expect(unknownEvents.flatMap((event) => event.ops)).toContainEqual({
      op: 'tool.count.set',
      count: undefined,
    });
    unknownMain.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    unknownMain.bus.emit(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    unknownMain.bus.emit(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call-unknown', name: 'Read', args: {} }),
    );
    expect(unknownEvents.at(-1)?.ops.at(-1)).toEqual({
      op: 'tool.count.set',
      count: undefined,
    });
    unknownService.dropSession('s1');
  });

  it('[STAT-R1] coalesces concurrent reads of the same wire file', async () => {
    const home = await seedWireHomeWithTool();
    let release!: () => void;
    let entered!: () => void;
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let firstRead = true;
    let reads = 0;
    let bytes = 0;
    const reader: NonNullable<TranscriptServiceDeps['toolCallCountReader']> = async (
      wirePath,
      fileSize,
      options,
    ) => {
      if (firstRead) {
        firstRead = false;
        entered();
        await readGate;
      }
      return readWireRecordsBounded(wirePath, fileSize, {
        ...options,
        onRead: (amount) => {
          reads += 1;
          bytes += amount;
          options.onRead?.(amount);
        },
      });
    };
    try {
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        toolCallCountReader: reader,
      });
      const first = service.getAgentToolCallCounts('s1', ['main']);
      await readEntered;
      const second = service.getAgentToolCallCounts('s1', ['main']);
      release();
      const [firstCounts, secondCounts] = await Promise.all([first, second]);
      expect(firstCounts.get('main')).toBe(1);
      expect(secondCounts.get('main')).toBe(1);
      expect(reads).toBe(1);
      expect(bytes).toBe(749);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

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

    expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).has('main')).toBe(false);
    const transcript = store?.getAgent('main');
    if (transcript === undefined) throw new Error('expected materialized main transcript');
    const snapshot = transcript.snapshot();
    const rewritten: AgentTranscriptSnapshot = {
      ...snapshot,
      toolCallCountKnown: true,
      toolCallCount: 2,
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

  describe('cold snapshot reads', () => {
    it('shares one wire scan across concurrent cold reads of the same agent', async () => {
      const home = await seedWireHomeWithTool();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const scans: string[] = [];
      let gated = false;
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        wireRecordReader: async (wirePath, options) => {
          scans.push(wirePath);
          if (!gated) {
            gated = true;
            entered();
            await gate;
          }
          return streamWireRecords(wirePath, options);
        },
      });
      try {
        const first = service.readColdSnapshot('s1', 'main');
        await started;
        const second = service.readColdSnapshot('s1', 'main');
        const third = service.readColdSnapshot('s1', 'main');
        release();
        const [firstSnapshot, secondSnapshot, thirdSnapshot] = await Promise.all([
          first,
          second,
          third,
        ]);
        expect(scans).toHaveLength(1);
        expect(secondSnapshot).toEqual(firstSnapshot);
        expect(thirdSnapshot).toEqual(firstSnapshot);
        expect(firstSnapshot?.toolCallCount).toBe(1);
        expect(firstSnapshot?.toolCallCountKnown).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('reuses a projection checkpoint and scans only an appended wire tail', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const filler = Array.from({ length: 300 }, (_, index) =>
        JSON.stringify({ type: 'executor.runtime.update', kind: 'stable', index }));
      await appendFile(wirePath, `${filler.join('\n')}\n`);
      const starts: (number | undefined)[] = [];
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        wireRecordReader: async (path, options) => {
          starts.push(options.startByteOffset);
          return streamWireRecords(path, options);
        },
      });
      try {
        const first = await service.readColdSnapshot('s1', 'main');
        expect(first?.items.length).toBeGreaterThan(0);
        const checkpointSize = (await fsPromises.stat(wirePath)).size;
        await appendFile(wirePath, `${JSON.stringify({
          type: 'turn.prompt',
          turnId: 1,
          promptId: 'tail-prompt',
          input: [{ type: 'text', text: 'tail' }],
          origin: { kind: 'user' },
          time: 10,
        })}\n${JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 11 })}\n`);

        const second = await service.readColdSnapshot('s1', 'main');
        expect(starts).toEqual([undefined, checkpointSize]);
        expect(second?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
        expect(service.memoryReport().coldReads.records).toBeLessThan(350);
      } finally {
        service.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('rebuilds pre-delivery projection checkpoints instead of reviving their phantom turns', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      await appendFile(wirePath, `${Array.from({ length: 300 }, (_, index) => JSON.stringify({ type: 'executor.runtime.update', kind: 'stable', index })).join('\n')}\n`);
      const core = fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents());
      const starts: (number | undefined)[] = [];
      const createService = () => new TranscriptService({
        homeDir: home, core,
        wireRecordReader: async (path, options) => {
          starts.push(options.startByteOffset);
          return streamWireRecords(path, options);
        },
      });
      const first = createService();
      let second: TranscriptService | undefined;
      try {
        const expected = await first.readColdSnapshot('s1', 'main');
        first.dispose();
        const query = core.accessor.get(IQueryStore);
        const key = 'ws\0s1\0main';
        const checkpoint = await query.get<{ format: number; snapshot: AgentTranscriptSnapshot }>('__transcript_projection_checkpoint__', key);
        expect(checkpoint?.format).toBe(2);
        await query.put('__transcript_projection_checkpoint__', key, {
          ...checkpoint, format: 1,
          snapshot: { ...checkpoint!.snapshot, items: [{ kind: 'turn', turnId: 't999', ordinal: 999, state: 'completed', origin: { kind: 'user' }, prompt: 'stale phantom', steps: [] }] },
        });
        second = createService();
        expect(await second.readColdSnapshot('s1', 'main')).toEqual(expected);
        expect(starts).toEqual([undefined, undefined]);
      } finally {
        first.dispose();
        second?.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('cancels the shared scan once the last reader leaves and rescans for the next one', async () => {
      const home = await seedWireHomeWithTool();
      let enteredScan!: () => void;
      let noticedAbort!: () => void;
      const scanStarted = new Promise<void>((resolve) => {
        enteredScan = resolve;
      });
      const scanAborted = new Promise<void>((resolve) => {
        noticedAbort = resolve;
      });
      const scans: string[] = [];
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        wireRecordReader: async (wirePath, options) => {
          scans.push(wirePath);
          enteredScan();
          try {
            return await streamWireRecords(wirePath, { ...options, chunkBytes: 8 });
          } catch (error) {
            if (options.signal?.aborted) noticedAbort();
            throw error;
          }
        },
      });
      const controller = new AbortController();
      try {
        const abandoned = service.readColdSnapshot('s1', 'main', undefined, controller.signal);
        await scanStarted;
        controller.abort(new DOMException('client gone', 'AbortError'));
        await expect(abandoned).rejects.toThrow('client gone');
        await scanAborted;
        expect(scans).toHaveLength(1);

        const next = await service.readColdSnapshot('s1', 'main');
        expect(scans).toHaveLength(2);
        expect(next?.toolCallCount).toBe(1);
        expect(next?.toolCallCountKnown).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it.each([
      { name: 'record fence', limits: { maxRecords: 3 } },
      { name: 'byte fence', limits: undefined },
      { name: 'line fence', limits: { maxLineBytes: 64 } },
    ])('[STAT-R3] fails a cold read that trips the $name instead of serving a prefix', async ({ limits }) => {
      const home = await seedWireHomeWithTool();
      const warnings: { bindings: unknown; message: string }[] = [];
      try {
        const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
        const resolved = limits ?? { maxBytes: Math.floor((await fsPromises.stat(wirePath)).size / 2) };
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
          coldReadLimits: resolved,
          logger: { warn: (bindings, message) => warnings.push({ bindings, message }) },
        });
        const snapshot = await service.readColdSnapshot('s1', 'main');
        expect(snapshot?.items).toEqual([]);
        expect(snapshot?.tasks).toEqual([]);
        expect(snapshot?.toolCallCount).toBeUndefined();
        expect(snapshot?.toolCallCountKnown).toBe(false);
        expect(warnings).toEqual([
          {
            bindings: expect.objectContaining({ sessionId: 's1', agentId: 'main' }),
            message: 'transcript: history snapshot unavailable (wire read fence tripped)',
          },
        ]);

        const store = service.forSessionLive('s1');
        await service.whenReady('s1');
        await service.ensureAgentHistory('s1', 'main');
        const live = store?.getAgent('main')?.snapshot();
        expect(live?.items).toEqual([]);
        expect(live?.toolCallCountKnown).toBe(false);
        expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).has('main')).toBe(false);
        expect((await service.getAgentToolCallCounts('s1', ['main'])).has('main')).toBe(false);
        service.dropSession('s1');
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('keeps the readable prefix when the wire itself ends in a partial tail', async () => {
      const home = await seedWireHomeWithTool();
      try {
        const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
        await appendFile(wirePath, '{"type":');
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        });
        const snapshot = await service.readColdSnapshot('s1', 'main');
        expect(snapshot?.items.some((item) => item.kind === 'turn')).toBe(true);
        expect(snapshot?.toolCallCount).toBeUndefined();
        expect(snapshot?.toolCallCountKnown).toBe(false);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('keeps preserve semantics out of the shared flight', async () => {
      const home = await seedWireHomeWithTool(false);
      try {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const readings: string[] = [];
        let gated = false;
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
          wireRecordReader: async (wirePath, options) => {
            readings.push(wirePath);
            if (!gated) {
              gated = true;
              entered();
              await gate;
            }
            return streamWireRecords(wirePath, options);
          },
        });
        const preserved = service.readColdSnapshot('s1', 'main', () => ['t0']);
        await started;
        const plain = service.readColdSnapshot('s1', 'main');
        release();
        const [preservedSnapshot, plainSnapshot] = await Promise.all([preserved, plain]);
        expect(readings).toHaveLength(2);
        expect(preservedSnapshot).not.toEqual(plainSnapshot);
        expect(preservedSnapshot?.items.find((item) => item.kind === 'turn')).toMatchObject({
          turnId: 't0',
          state: 'running',
        });
        expect(plainSnapshot?.items.find((item) => item.kind === 'turn')).toMatchObject({
          turnId: 't0',
          state: 'cancelled',
        });
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('[STAT-R3] folds CRLF, blank lines, and an unterminated tail like a plain wire', async () => {
      const records = [
        {
          type: 'turn.prompt',
          turnId: 0,
          promptId: 'prompt-shape',
          input: [{ type: 'text', text: 'hi' }],
          origin: { kind: 'user' },
          time: 1_000,
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-shape' },
          time: 2_000,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            turnId: 0,
            stepUuid: 'step-shape',
            toolCallId: 'call_shape',
            name: 'Bash',
            args: { command: 'ls' },
          },
          time: 3_000,
        },
      ];
      const lines = records.map((record) => JSON.stringify(record));
      const variants = [
        { name: 'plain', raw: `${lines.join('\n')}\n` },
        { name: 'crlf', raw: `${lines.join('\r\n')}\r\n\r\n` },
        { name: 'unterminated', raw: lines.join('\n') },
      ];
      const snapshots: (AgentTranscriptSnapshot | undefined)[] = [];
      for (const variant of variants) {
        const home = await mkdtemp(join(tmpdir(), `transcript-cold-${variant.name}-`));
        try {
          const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
          await mkdir(wireDir, { recursive: true });
          await writeFile(join(wireDir, 'wire.jsonl'), variant.raw);
          const service = new TranscriptService({
            homeDir: home,
            core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
          });
          snapshots.push(await service.readColdSnapshot('s1', 'main'));
        } finally {
          await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
        }
      }
      expect(snapshots[0]?.items.some((item) => item.kind === 'turn')).toBe(true);
      expect(snapshots[0]?.toolCallCount).toBe(1);
      expect(snapshots[0]?.toolCallCountKnown).toBe(true);
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(snapshots[2]).toEqual(snapshots[0]);
    });

    it.each([
      { name: 'the transcript page', path: '/sessions/:session_id/transcript', query: { agent_id: 'main' } },
      { name: 'the user-messages list', path: '/sessions/:session_id/transcript/user-messages', query: {} },
      { name: 'the plan list', path: '/sessions/:session_id/transcript/plan', query: { agent_id: 'main' } },
    ])('[STAT-R3] cancels the cold wire read when the client disconnects from $name', async ({ path, query }) => {
      const home = await seedWireHomeWithTool();
      try {
        let enteredScan!: () => void;
        const scanStarted = new Promise<void>((resolve) => {
          enteredScan = resolve;
        });
        let releaseScan!: () => void;
        const scanGate = new Promise<void>((resolve) => {
          releaseScan = resolve;
        });
        let noticedAbort!: () => void;
        const abortSeen = new Promise<void>((resolve) => {
          noticedAbort = resolve;
        });
        const service = new TranscriptService({
          homeDir: home,
          core: coldCore(),
          wireRecordReader: async (wirePath, options) => {
            enteredScan();
            options.signal?.addEventListener('abort', () => noticedAbort(), { once: true });
            await scanGate;
            return streamWireRecords(wirePath, options);
          },
        });
        const handlers = new Map<string, (req: unknown, reply: unknown) => Promise<void> | void>();
        registerTranscriptRoutes(
          {
            get: (routePath: string, _options: unknown, handler: (req: unknown, reply: unknown) => Promise<void> | void) => {
              handlers.set(routePath, handler);
            },
          } as unknown as Parameters<typeof registerTranscriptRoutes>[0],
          { core: coldCore(), transcriptService: service },
        );
        const raw = new EventEmitter() as EventEmitter & { writableFinished: boolean };
        raw.writableFinished = false;
        const sent: unknown[] = [];
        const reply = {
          send: (payload: unknown) => {
            sent.push(payload);
            return payload;
          },
          raw,
        };
        const pending = Promise.resolve(
          handlers.get(path)!(
            { id: 'req-1', params: { session_id: 's1' }, query },
            reply,
          ),
        );
        await scanStarted;
        raw.emit('close');
        await abortSeen;
        releaseScan();
        const error = await pending.then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect((error as Error | undefined)?.name).toBe('AbortError');
        expect(sent).toEqual([]);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('does not start a user-messages wire scan after disconnecting during roster lookup', async () => {
      let enteredRoster!: () => void;
      const rosterStarted = new Promise<void>((resolve) => {
        enteredRoster = resolve;
      });
      let releaseRoster!: () => void;
      const rosterGate = new Promise<void>((resolve) => {
        releaseRoster = resolve;
      });
      let wireReads = 0;
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: coldCore(),
        wireRecordReader: async (wirePath, options) => {
          wireReads += 1;
          return streamWireRecords(wirePath, options);
        },
      });
      vi.spyOn(service, 'readColdRoster').mockImplementation(async () => {
        enteredRoster();
        await rosterGate;
        return [{ agentId: 'main', type: 'main' }];
      });
      const handlers = new Map<string, (req: unknown, reply: unknown) => Promise<void> | void>();
      registerTranscriptRoutes(
        {
          get: (routePath: string, _options: unknown, handler: (req: unknown, reply: unknown) => Promise<void> | void) => {
            handlers.set(routePath, handler);
          },
        } as unknown as Parameters<typeof registerTranscriptRoutes>[0],
        { core: coldCore(), transcriptService: service },
      );
      const raw = new EventEmitter() as EventEmitter & { writableFinished: boolean };
      raw.writableFinished = false;
      const sent: unknown[] = [];
      const pending = Promise.resolve(
        handlers.get('/sessions/:session_id/transcript/user-messages')!(
          { id: 'req-1', params: { session_id: 's1' }, query: {} },
          {
            send: (payload: unknown) => {
              sent.push(payload);
              return payload;
            },
            raw,
          },
        ),
      );
      await rosterStarted;
      raw.emit('close');
      releaseRoster();
      const error = await pending.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect((error as Error | undefined)?.name).toBe('AbortError');
      expect(wireReads).toBe(0);
      expect(sent).toEqual([]);
    });
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
      expect(store.getAgent('main')?.snapshot()).toEqual({
        ...rewritten,
        toolCallCount: 0,
        toolCallCountKnown: true,
      });
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

    it('keeps a continuous newest window after repeated evictions compact the journal head', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');

      const extra = 1100;
      for (let turnId = 1; turnId <= TRANSCRIPT_OPS_JOURNAL_CAPACITY + extra; turnId++) {
        main.bus.emit(ev({ type: 'turn.started', turnId, origin: { kind: 'user' } }));
      }
      const watermark = service.getSeqWatermark('s1', 'main');
      expect(watermark).toBe(base + TRANSCRIPT_OPS_JOURNAL_CAPACITY + extra);

      const window = service.getOpsSince('s1', 'main', watermark - TRANSCRIPT_OPS_JOURNAL_CAPACITY);
      expect(window?.complete).toBe(true);
      expect(window?.batches).toHaveLength(TRANSCRIPT_OPS_JOURNAL_CAPACITY);
      expect(window?.batches[0]?.seq).toBe(watermark - TRANSCRIPT_OPS_JOURNAL_CAPACITY + 1);

      const evicted = service.getOpsSince('s1', 'main', base);
      expect(evicted?.complete).toBe(false);
      service.dropSession('s1');
    });

    it('drops a batch over the agent byte cap without retaining it or the prefix it gaps', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        opsJournalLimits: { maxAgentBytes: 640, maxSessionBytes: 1 << 20, maxTotalBytes: 1 << 20 },
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');
      const epoch = service.getTranscriptCursor('s1', 'main').epoch;

      main.bus.emit(
        ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'a'.repeat(32) }),
      );
      expect(service.getTranscriptCursor('s1', 'main')).toMatchObject({ seq: base + 1, epoch });

      main.bus.emit(
        ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'b'.repeat(2048) }),
      );
      const watermark = service.getSeqWatermark('s1', 'main');
      expect(watermark).toBe(base + 2);

      const beforeGap = service.getOpsSince('s1', 'main', base);
      expect(beforeGap).toMatchObject({ epoch, throughSeq: watermark, complete: false });
      expect(beforeGap?.batches).toEqual([]);
      expect(service.getOpsSince('s1', 'main', base + 1)?.complete).toBe(false);

      main.bus.emit(ev({ type: 'turn.started', turnId: 3, origin: { kind: 'user' }, prompt: 'ok' }));
      const afterGap = service.getOpsSince('s1', 'main', base + 2);
      expect(afterGap?.complete).toBe(true);
      expect(afterGap?.epoch).toBe(epoch);
      expect(afterGap?.batches.map((batch) => batch.seq)).toEqual([base + 3]);
      expect(service.getOpsSince('s1', 'main', base + 1)?.complete).toBe(false);
      service.dropSession('s1');
    });

    it('evicts the oldest retained batch once the per-agent byte budget trips', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        opsJournalLimits: { maxAgentBytes: 3000, maxSessionBytes: 1 << 20, maxTotalBytes: 1 << 20 },
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');
      const epoch = service.getTranscriptCursor('s1', 'main').epoch;

      for (let turnId = 1; turnId <= 4; turnId += 1) {
        main.bus.emit(
          ev({ type: 'turn.started', turnId, origin: { kind: 'user' }, prompt: 'm'.repeat(512) }),
        );
      }
      const watermark = service.getSeqWatermark('s1', 'main');
      expect(watermark).toBe(base + 4);

      const evicted = service.getOpsSince('s1', 'main', base);
      expect(evicted?.complete).toBe(false);
      expect(evicted?.throughSeq).toBe(watermark);
      const recent = service.getOpsSince('s1', 'main', base + 2);
      expect(recent?.complete).toBe(true);
      expect(recent?.epoch).toBe(epoch);
      expect(recent?.batches.map((batch) => batch.seq)).toEqual([base + 3, base + 4]);
      expect(service.getOpsSince('s1', 'main', { epoch: 'ep_stale', seq: base + 2 })?.complete).toBe(
        false,
      );
      service.dropSession('s1');
    });

    it('enforces the per-session byte budget across agent journals', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        opsJournalLimits: { maxAgentBytes: 1 << 20, maxSessionBytes: 3000, maxTotalBytes: 1 << 20 },
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');

      for (let turnId = 1; turnId <= 2; turnId += 1) {
        main.bus.emit(
          ev({ type: 'turn.started', turnId, origin: { kind: 'user' }, prompt: 'm'.repeat(512) }),
        );
      }
      expect(service.getOpsSince('s1', 'main', base)?.complete).toBe(true);
      expect(service.getOpsSince('s1', 'main', base)?.batches).toHaveLength(2);

      const sub = agents.add('sub-1');
      sub.bus.emit(
        ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 's'.repeat(512) }),
      );
      const subCatchup = service.getOpsSince('s1', 'sub-1', 0);
      expect(subCatchup?.throughSeq).toBe(1);
      expect(subCatchup?.complete).toBe(false);
      expect(subCatchup?.batches).toEqual([]);

      const mainCatchup = service.getOpsSince('s1', 'main', base);
      expect(mainCatchup?.complete).toBe(true);
      expect(mainCatchup?.batches).toHaveLength(2);
      service.dropSession('s1');
    });
  });
});
