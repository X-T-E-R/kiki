import { appendFile as appendFixtureFile, mkdtemp, mkdir, rm, writeFile as writeFixtureFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentTaskService,
  IEventBus,
  ISessionIndex,
  ISessionInteractionService,
  ISessionStateService,
  ISessionMetadata,
  IQueryStore,
  ISessionLifecycleService,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWireService,
  LifecycleScope,
  SessionInteractionService,
  StateRegistry,
  type Event2,
  type ISessionScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  AgentTranscriptDraft,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  transcriptResponseSchema,
  transcriptResetPayloadSchema,
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
import { readColdSessionViewBaseline, readSessionViewTranscriptPage } from '../../src/transport/klient/sessionViewReads';
import { TestInstantiationService } from '../../../agent-core-v2/src/_base/di/test';
import { SyncDescriptor } from '../../../agent-core-v2/src/_base/di/descriptors';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '../../../agent-core-v2/src/_base/errors/unexpectedError';
import { InMemoryStorageService } from '../../../agent-core-v2/src/persistence/backends/memory/inMemoryStorageService';
import { FileStorageService } from '../../../agent-core-v2/src/persistence/backends/node-fs/fileStorageService';
import { AppendLogStore } from '../../../agent-core-v2/src/persistence/backends/node-fs/appendLogStore';
import { noopTelemetryService } from '../../../agent-core-v2/src/app/telemetry/telemetry';
import { noopLogger, registerTestAgentWire, stubAgentWire } from '../../../agent-core-v2/test/wire/stubs';
import { WIRE_TRANSCRIPT_RECEIPT_KEY, digestWireBytes } from '../../../agent-core-v2/src/wire/transcriptReceipt';
import * as transcriptReceipt from '../../../agent-core-v2/src/wire/transcriptReceipt';

vi.mock('node:fs/promises', { spy: true });

async function sealFixtureWire(path: string): Promise<void> {
  const digest = await digestWireBytes(createReadStream(path));
  const wire = { size: digest.size, sha256: digest.sha256 };
  await writeFixtureFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({
    format: 1, epoch: 'verified-test-fixture', state: 'sealed', trusted: true, wire,
  }));
}

async function writeFile(path: string, content: string | Uint8Array): Promise<void> {
  await writeFixtureFile(path, content);
  if (path.endsWith('wire.jsonl')) await sealFixtureWire(path);
}

async function appendFile(path: string, content: string | Uint8Array): Promise<void> {
  await appendFixtureFile(path, content);
  if (path.endsWith('wire.jsonl')) await sealFixtureWire(path);
}

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

  it('bounded cold snapshots expose the wire record fence and readable prefix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-cold-bounded-'));
    const service = new TranscriptService({ homeDir: home, core: coldCore() });
    try {
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const records = [
        {
          type: 'context.append_message', time: 1000,
          message: { role: 'user', content: [{ type: 'text', text: 'first bounded turn' }], origin: { kind: 'user' } },
        },
        {
          type: 'context.append_message', time: 2000,
          message: { role: 'user', content: [{ type: 'text', text: 'second bounded turn' }], origin: { kind: 'user' } },
        },
      ];
      const wirePath = join(wireDir, 'wire.jsonl');
      await writeFixtureFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

      const result = await service.readColdSnapshotBounded('s1', 'main', {
        maxBytes: 1 << 20, maxRecords: 1, chunkBytes: 1 << 20,
      });
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('record_budget');
      expect(result.recordsRead).toBe(1);
      expect(result.snapshot?.items.some((item) =>
        item.kind === 'turn' && item.prompt === 'first bounded turn')).toBe(true);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps two independently cropped media results in cold transcript frames', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-cold-media-'));
    const service = new TranscriptService({ homeDir: home, core: coldCore() });
    try {
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const path = 'C:\\work\\shots\\home.png';
      const crops = [
        { region: { x: 0, y: 0, width: 2, height: 2 }, hash: 'a'.repeat(64) },
        { region: { x: 2, y: 0, width: 2, height: 2 }, hash: 'b'.repeat(64) },
      ];
      const outputs = crops.map(({ hash }) => [
        { type: 'text', text: `<image path="${path}">` },
        { type: 'image_url', imageUrl: { url: `blobref:image/png;${hash}` } },
        { type: 'text', text: '</image>' },
      ]);
      const records = [
        {
          type: 'turn.prompt', turnId: 0, promptId: 'prompt-1',
          input: [{ type: 'text', text: 'view this' }], origin: { kind: 'user' }, time: 1000,
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' }, time: 2000,
        },
        ...crops.flatMap(({ region }, index) => [
          {
            type: 'context.append_loop_event',
            event: {
              type: 'tool.call', turnId: 0, stepUuid: 'step-1', uuid: `part-tool-${index}`,
              toolCallId: `call-media-${index}`, name: 'ReadMediaFile', args: { path, region },
            },
            time: 3000 + index * 2000,
          },
          {
            type: 'context.append_loop_event',
            event: {
              type: 'tool.result', toolCallId: `call-media-${index}`,
              result: { output: outputs[index], isError: false },
            },
            time: 4000 + index * 2000,
          },
        ]),
      ];
      await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

      const snapshot = await service.readColdSnapshot('s1', 'main');
      const turn = snapshot?.items.find((item) => item.kind === 'turn');
      const frames = turn?.kind === 'turn'
        ? turn.steps.flatMap((step) => step.frames).filter((item) => item.kind === 'tool')
        : [];
      expect(frames).toEqual([
        expect.objectContaining({ kind: 'tool', name: 'ReadMediaFile', output: outputs[0] }),
        expect.objectContaining({ kind: 'tool', name: 'ReadMediaFile', output: outputs[1] }),
      ]);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true });
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
    add(id: string, opts?: { loopStatus?: unknown; tasks?: readonly unknown[]; prompts?: { active?: unknown; pending?: readonly unknown[] }; wire?: IWireService }): FakeAgentHandle {
      const bus = new FakeBus();
      const handle: FakeAgentHandle = {
        id,
        bus,
        accessor: {
          get: (token: unknown) => {
            if (token === IEventBus) return bus;
            if (token === IWireService) return opts?.wire;
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
    interactions: ISessionInteractionService,
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

  function fakeCoreWithAgents(interactions: ISessionInteractionService, agents: FakeAgents): Scope {
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

  it('carries independent working notes through live ops, validated pages and cold reconnect after restart', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    const main = agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    const cold = new TranscriptService({ homeDir: home, core: coldCore() });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const child = agents.add('child-notes', { wire: stubAgentWire() });
      const events: { agentId: string; ops: readonly TranscriptOperation[] }[] = [];
      service.onSessionOps('s1', (event) => events.push(event));
      for (const handle of [main, child]) {
        const notes = {
          goal: `${handle.id} goal`, directives: 'Read only', decided: 'Reuse existing channel', rejected: 'New endpoint',
          evidence: 'Tests pass', files: 'example.ts', next: 'Review', open: 'None',
        };
        const notesMeta = { rev: 1, hash: `${handle.id}-hash`, writtenTurn: 0, writtenStep: 't0.1', coveredMessageId: 'msg-1', windowEpoch: 0 };
        const records = [
          { type: 'tools.update_store', key: 'todo_notes', value: { notes, notesMeta }, time: 4000 },
          { type: 'tools.update_store', key: 'todo', value: [{ title: `${handle.id} todo`, status: 'pending' }], time: 5000 },
        ];
        for (const record of records) handle.bus.emit(ev(record));
        const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', handle.id);
        await mkdir(wireDir, { recursive: true });
        const serialized = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
        if (handle.id === 'main') await appendFile(join(wireDir, 'wire.jsonl'), serialized);
        else await writeFile(join(wireDir, 'wire.jsonl'), serialized);
        expect(store.getAgent(handle.id)?.getTodo('todo')).toMatchObject({ notes, notesMeta });
        expect(events.some((event) => event.agentId === handle.id && event.ops.some((op) => op.op === 'todo.upsert' && op.todo.notes?.goal === notes.goal))).toBe(true);
        const livePage = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(service, 's1', { agentId: handle.id }));
        expect(livePage.todos).toEqual([expect.objectContaining({ todoId: 'todo', notes, notesMeta })]);
      }
      service.dispose();
      for (const agentId of ['main', 'child-notes']) {
        const page = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(cold, 's1', { agentId }));
        expect(page.todos[0]).toMatchObject({ notes: { goal: `${agentId} goal`, directives: 'Read only', open: 'None' }, notesMeta: { rev: 1 } });
        for (const grade of ['turn', 'block', 'delta'] as const) {
          const baseline = transcriptResetPayloadSchema.parse(await readColdSessionViewBaseline(cold, 's1', agentId, grade, new AbortController().signal));
          expect(baseline.snapshot.todos).toEqual(page.todos);
        }
      }
      const cleared = { type: 'tools.update_store', key: 'todo_notes', value: { notesMeta: { rev: 2, hash: 'cleared', writtenTurn: 0, writtenStep: 't0.2', coveredMessageId: 'msg-2', windowEpoch: 0 } }, time: 6000 };
      await appendFile(join(home, 'sessions', 'ws', 's1', 'agents', 'child-notes', 'wire.jsonl'), `${JSON.stringify(cleared)}\n`);
      const childPage = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(cold, 's1', { agentId: 'child-notes' }));
      expect(childPage.todos[0]?.notes).toBeUndefined();
      expect(childPage.todos[0]?.notesMeta?.rev).toBe(2);
      expect((await readSessionViewTranscriptPage(cold, 's1', { agentId: 'main' }))?.todos[0]?.notes?.goal).toBe('main goal');
    } finally {
      service.dispose();
      cold.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it.each(['rewrite', 'backfill retry'] as const)(
    'keeps an engine-pending question pending across %s before and after 30 seconds',
    async (refresh) => {
      const home = await seedWireHome();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const ix = new TestInstantiationService();
      ix.set(ISessionStateService, new TestSessionStateService());
      ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
      const interactions = ix.get(ISessionInteractionService);
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const request = { turnId: 0, questions: [{ question: 'Choose?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] };
      const record = { type: 'interaction.request', id: 'question-live', kind: 'question', request, origin: { agentId: 'main', turnId: 0 }, time: 1_000 };
      interactions.enqueue({ id: record.id, kind: 'question', payload: request, origin: record.origin });
      if (refresh === 'rewrite') await appendFile(wirePath, `${JSON.stringify(record)}\n`);
      const service = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(interactions, agents) });
      if (refresh === 'backfill retry') vi.spyOn(service, 'readColdSnapshot').mockResolvedValueOnce(undefined);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        const store = service.forSessionLive('s1')!;
        await service.whenReady('s1');
        const transcript = store.ensureAgent('main');
        expect(transcript.getInteractions().get(record.id)?.state).toBe('pending');
        if (refresh === 'backfill retry') await appendFile(wirePath, `${JSON.stringify(record)}\n`);
        for (const elapsed of [29_999, 30_001]) {
          clock.mockReturnValue(1_000 + elapsed);
          if (refresh === 'rewrite') await service.reconcileAfterRewrite('s1');
          else await service.ensureAgentHistory('s1', 'main');
          expect(interactions.listPending('question').map((entry) => entry.id)).toEqual([record.id]);
          expect(transcript.getInteractions().get(record.id)?.state).toBe('pending');
          const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
          expect(page?.interactions).toContainEqual(expect.objectContaining({ interactionId: record.id, state: 'pending' }));
        }
        transcript.apply([{ op: 'reset', agentId: 'main', snapshot: { ...transcript.snapshot(), hasMoreOlder: true } }]);
        const older = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't1' });
        expect(older?.interactions).toContainEqual(expect.objectContaining({ interactionId: record.id, state: 'pending' }));
        expect(older?.pending_interactions).toEqual([record.id]);
        interactions.respond(record.id, { answers: { 'Choose?': 'Alpha' } });
        expect(interactions.listPending('question')).toEqual([]);
        expect(transcript.getInteractions().get(record.id)?.state).toBe('answered');
        await appendFile(wirePath, `${JSON.stringify({ type: 'interaction.resolved', id: record.id, response: { answers: { 'Choose?': 'Alpha' } }, time: 31_002 })}\n`);
        await service.reconcileAfterRewrite('s1');
        expect(transcript.getInteractions().get(record.id)?.state).toBe('answered');
      } finally {
        clock.mockRestore();
        service.dispose();
        ix.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  );

  it.each(['answered', 'dismissed'] as const)('keeps a question %s during an asynchronous history read terminal', async (state) => {
    const home = await seedWireHome();
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    const ix = new TestInstantiationService();
    ix.set(ISessionStateService, new TestSessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    const interactions = ix.get(ISessionInteractionService);
    const agents = new FakeAgents();
    agents.add('main');
    const request = { questions: [{ question: 'Choose?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] };
    const response = state === 'answered' ? { answers: { 'Choose?': 'Alpha' } } : null;
    interactions.enqueue({ id: 'question-race', kind: 'question', payload: request, origin: { agentId: 'main' } });
    await appendFile(wirePath, `${JSON.stringify({ type: 'interaction.request', id: 'question-race', kind: 'question', request })}\n`);
    let onRead: (() => void) | undefined;
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(interactions, agents),
      wireRecordReader: async (path, options) => {
        const read = await streamWireRecords(path, options);
        onRead?.();
        return read;
      },
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      onRead = () => { interactions.respond('question-race', response); };
      await service.reconcileAfterRewrite('s1');
      expect(interactions.listPending()).toEqual([]);
      expect(store.getAgent('main')?.getInteractions().get('question-race')).toMatchObject({ state, response });
    } finally {
      service.dispose();
      ix.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('preserves live child question mirrors absent from the main wire during a rewrite', async () => {
    const home = await seedWireHome();
    const ix = new TestInstantiationService();
    ix.set(ISessionStateService, new TestSessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    const interactions = ix.get(ISessionInteractionService);
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(interactions, agents) });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      agents.add('child');
      interactions.enqueue({
        id: 'question-child', kind: 'question', origin: { agentId: 'child' },
        payload: { questions: [{ question: 'Choose?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] },
      });
      await service.reconcileAfterRewrite('s1');
      for (const agentId of ['main', 'child']) {
        expect(store.getAgent(agentId)?.getInteractions().get('question-child')?.state).toBe('pending');
      }
      interactions.respond('question-child', { answers: { 'Choose?': 'Alpha' } });
      for (const agentId of ['main', 'child']) {
        expect(store.getAgent(agentId)?.getInteractions().get('question-child')?.state).toBe('answered');
      }
    } finally {
      service.dispose();
      ix.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('settles only orphan questions when rebuilding a cold or live session with no engine pending', async () => {
    const home = await seedWireHome();
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await appendFile(wirePath, `${JSON.stringify({ type: 'interaction.request', id: 'question-orphan', kind: 'question', request: { questions: [] } })}\n`);
    const cold = new TranscriptService({ homeDir: home, core: coldCore() });
    const ix = new TestInstantiationService();
    ix.set(ISessionStateService, new TestSessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    const agents = new FakeAgents();
    agents.add('main');
    const live = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(ix.get(ISessionInteractionService), agents) });
    try {
      expect((await cold.readColdSnapshot('s1'))?.interactions).toContainEqual(expect.objectContaining({ interactionId: 'question-orphan', state: 'cancelled' }));
      const store = live.forSessionLive('s1')!;
      await live.whenReady('s1');
      await live.reconcileAfterRewrite('s1');
      expect(store.getAgent('main')?.getInteractions().get('question-orphan')?.state).toBe('cancelled');
      expect(store.getAgent('main')?.listPendingInteractions()).toEqual([]);
    } finally {
      cold.dispose();
      live.dispose();
      ix.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('keeps replayed and live completed turns resident under explicit memory limits without durability clearance', async () => {
    const home = await seedWireHome(undefined, true);
    const agents = new FakeAgents();
    const main = agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      residentLimits: { tailTurns: 1, maxBytes: 1 },
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const transcript = store.getAgent('main')!;
      expect(transcript.getTurn('t0')).toMatchObject({ state: 'completed', prompt: 'hi' });
      main.bus.emit(ev({
        type: 'turn.prompt', turnId: 1, promptId: 'prompt-2',
        input: [{ type: 'text', text: 'second' }], origin: { kind: 'user' }, time: 3_000,
      }));
      main.bus.emit(ev({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 4_000 }));
      expect(transcript.getTurn('t0')?.prompt).toBe('hi');
      expect(transcript.getTurn('t1')?.prompt).toBe('second');
      expect(transcript.residentReport()).toMatchObject({ turns: 2, trimmedTurns: 0, overBudget: true });
      expect(transcript.snapshot({ tailTurns: 1 }).items.filter((item) => item.kind === 'turn').map((item) => item.turnId)).toEqual(['t1']);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('reopens healthy completed child history for GUI pages and reconnect after idle release', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const child = agents.add('child-healthy', { wire: stubAgentWire() });
      const records = [0, 1].flatMap((turnId) => [
        {
          type: 'turn.prompt', turnId, promptId: `prompt-${turnId}`,
          input: [{ type: 'text', text: `healthy-${turnId}` }], origin: { kind: 'user' }, time: turnId * 2_000 + 1_000,
        },
        { type: 'turn.ended', turnId, reason: 'completed', time: turnId * 2_000 + 2_000 },
      ]);
      for (const record of records) child.bus.emit(ev(record));
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'child-healthy');
      await mkdir(wireDir, { recursive: true });
      await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      expect(store.getAgent('child-healthy')?.snapshot()).toEqual(await service.readColdSnapshot('s1', 'child-healthy'));
      agents.remove('child-healthy');
      await service.ensureAgentHistory('s1', 'child-healthy');
      const latest = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child-healthy', pageSize: 1 });
      const older = await readSessionViewTranscriptPage(service, 's1', {
        agentId: 'child-healthy', beforeTurn: 't1', pageSize: 1,
      });
      expect(latest?.items).toEqual([expect.objectContaining({ kind: 'turn', turnId: 't1', prompt: 'healthy-1' })]);
      expect(older?.items).toEqual([expect.objectContaining({ kind: 'turn', turnId: 't0', prompt: 'healthy-0' })]);
      const cursor = service.getTranscriptCursor('s1', 'child-healthy');
      expect(service.getOpsSince('s1', 'child-healthy', { epoch: cursor.epoch, seq: 0 })?.complete).toBe(true);
      expect(store.getAgent('child-healthy')?.snapshot().items.filter((item) => item.kind === 'turn')).toHaveLength(2);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('does not certify a same-length same-line in-place rewrite of a trusted open wire', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    const ix = new TestInstantiationService();
    const storage = new FileStorageService(home);
    const log = new AppendLogStore(storage);
    const scope = 'sessions/ws/s1/agents/child-tamper';
    const wire = registerTestAgentWire(ix, scope, {
      log, storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    try {
      await wire.seal();
      await wire.beginTranscriptEpoch!();
      agents.add('child-tamper', { wire });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      wire.appendRecord({
        type: 'turn.prompt', turnId: 0, promptId: 'p0',
        input: [{ type: 'text', text: 'a' }], origin: { kind: 'user' }, time: 1_000,
      });
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
      const path = storage.pathFor(scope, 'wire.jsonl');
      const original = await fsPromises.readFile(path, 'utf8');
      const changed = original.replace('"text":"a"', '"text":"b"');
      expect(changed).not.toBe(original);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
      expect(changed.split('\n').length).toBe(original.split('\n').length);
      await writeFixtureFile(path, changed);
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
      const cold = await service.readColdSnapshot('s1', 'child-tamper');
      expect(cold).toMatchObject({ toolCallCountKnown: false, hasMoreOlder: true });
      expect(cold?.items).toEqual([expect.objectContaining({ kind: 'turn', prompt: 'b' })]);
      const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child-tamper' });
      expect(page?.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(page?.tool_call_count).toBeUndefined();
      expect(page?.items).toEqual([expect.objectContaining({ kind: 'turn', prompt: 'b' })]);
      wire.appendRecord({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 });
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
      await expect(wire.sealTranscriptEpoch!()).rejects.toThrow('Transcript wire contents do not match accepted events');
      agents.remove('child-tamper');
      expect(await service.readColdSnapshot('s1', 'child-tamper')).toMatchObject({
        toolCallCountKnown: false, hasMoreOlder: true,
      });
    } finally {
      ix.dispose();
      log.dispose();
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('serves a healthy open child as full at a verified live watermark, then revokes it on a failed append', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    const ix = new TestInstantiationService();
    const wireStorage = new InMemoryStorageService();
    const wireLog = new AppendLogStore(wireStorage);
    const wire = registerTestAgentWire(ix, 'test/open-child', {
      log: wireLog, storage: wireStorage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await wire.seal();
      await wire.beginTranscriptEpoch!();
      const child = agents.add('child-open', { wire });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const prompt = {
        type: 'turn.prompt', turnId: 0, promptId: 'p0', input: [{ type: 'text', text: 'healthy' }],
        origin: { kind: 'user' }, time: 1_000,
      } as const;
      wire.appendRecord(prompt);
      child.bus.emit(ev(prompt));
      const ended = { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 } as const;
      wire.appendRecord(ended);
      child.bus.emit(ev(ended));
      await wire.flush();
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'child-open');
      await mkdir(wireDir, { recursive: true });
      await writeFixtureFile(join(wireDir, 'wire.jsonl'), (await wireStorage.read('test/open-child', 'wire.jsonl'))!);
      await writeFixtureFile(join(wireDir, WIRE_TRANSCRIPT_RECEIPT_KEY),
        (await wireStorage.read('test/open-child', WIRE_TRANSCRIPT_RECEIPT_KEY))!);
      const healthy = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child-open' });
      expect(healthy?.coverage).toEqual({ kind: 'full', hasMoreOlder: false });
      expect(healthy?.items).toEqual([expect.objectContaining({ kind: 'turn', prompt: 'healthy', state: 'completed' })]);
      expect(await service.readColdSnapshot('s1', 'child-open')).toMatchObject({ toolCallCountKnown: true });
      const failed = new Error('live dehydrator failed');
      wire.appendRecord({ type: 'turn.prompt', turnId: 1 }, async () => { throw failed; });
      await expect(wire.flush()).rejects.toBe(failed);
      expect(unexpected).toEqual([failed]);
      const uncertain = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child-open' });
      expect(uncertain?.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(uncertain?.tool_call_count).toBeUndefined();
      expect(service.getMaterializedAgentToolCallCounts('s1', ['child-open']).has('child-open')).toBe(false);
      expect((await service.getAgentToolCallCounts('s1', ['child-open'])).has('child-open')).toBe(false);
      agents.remove('child-open');
      service.dropSession('s1');
      const restarted = new TranscriptService({ homeDir: home, core: coldCore() });
      try {
        expect(await restarted.readColdSnapshot('s1', 'child-open')).toMatchObject({ toolCallCountKnown: false, hasMoreOlder: true });
      } finally {
        restarted.dispose();
      }
    } finally {
      resetUnexpectedErrorHandler();
      ix.dispose();
      wireLog.dispose();
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('refuses a disposed child history after a real wire dehydration failure despite a later successful append', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const warnings: string[] = [];
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      logger: { warn: (_details, message) => warnings.push(message) },
      residentLimits: { tailTurns: 1, maxBytes: 512 },
    });
    const ix = new TestInstantiationService();
    const wireStorage = new InMemoryStorageService();
    const wireLog = new AppendLogStore(wireStorage);
    const wire = registerTestAgentWire(ix, 'test/child', {
      log: wireLog,
      storage: wireStorage,
      logger: noopLogger,
      telemetry: noopTelemetryService,
    });
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await wire.seal();
      await wire.beginTranscriptEpoch!();
      const child = agents.add('child', { wire });
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      await service.ensureAgentHistory('s1', 'child');
      const failed = new Error('blob dehydration failed');
      let rejectDehydration!: (error: Error) => void;
      const gate = new Promise<void>((_resolve, reject) => { rejectDehydration = reject; });
      const prompt = {
        type: 'turn.prompt', turnId: 0, promptId: 'missing-prompt',
        input: [{ type: 'text', text: 'only in memory' }], origin: { kind: 'user' }, time: 1_000,
      } as const;
      const ended = { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 } as const;
      wire.appendRecord(prompt, async (record) => { await gate; return record; });
      child.bus.emit(ev(prompt));
      wire.appendRecord(ended);
      child.bus.emit(ev(ended));
      expect(store.getAgent('child')?.getTurn('t0')).toMatchObject({
        state: 'completed', prompt: 'only in memory',
      });
      rejectDehydration(failed);
      await expect(wire.flush()).rejects.toBe(failed);
      expect(unexpected).toEqual([failed]);
      const persistedWire = await wireStorage.read('test/child', 'wire.jsonl');
      expect(Buffer.from(persistedWire!).toString('utf8').trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['metadata', 'turn.ended']);
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'child');
      await mkdir(wireDir, { recursive: true });
      await writeFixtureFile(join(wireDir, 'wire.jsonl'), persistedWire!);
      const acceptance = await wireStorage.read('test/child', WIRE_TRANSCRIPT_RECEIPT_KEY);
      expect(JSON.parse(Buffer.from(acceptance!).toString('utf8'))).toMatchObject({ state: 'open', trusted: true });
      await writeFixtureFile(join(wireDir, WIRE_TRANSCRIPT_RECEIPT_KEY), acceptance!);
      agents.remove('child');
      expect(store.getAgent('child')).toBeUndefined();
      expect(service.getUnverifiedAgentSnapshot('s1', 'child')).toMatchObject({
        complete: false,
        snapshot: { items: [expect.objectContaining({ kind: 'turn', prompt: 'only in memory' })] },
      });
      expect(service.memoryReport()).toMatchObject({ unverifiedResidentAgents: 1 });
      await expect(service.ensureAgentHistory('s1', 'child')).rejects.toThrow('not verified against durable history');
      await expect(service.readColdSnapshot('s1', 'child')).rejects.toThrow('not verified against durable history');
      expect(() => service.getOpsSince('s1', 'child', 0)).toThrow('not verified against durable history');
      expect((await service.getAgentToolCallCounts('s1', ['child'])).has('child')).toBe(false);
      expect(warnings).toContain('transcript: disposed agent wire flush failed; refusing later reads');
      service.dropSession('s1');
      expect(service.getUnverifiedAgentSnapshot('s1', 'child')).toBeUndefined();
      expect(service.memoryReport()).toMatchObject({ unverifiedResidentAgents: 0, unverifiedResidentBytes: 0 });
      const reopened = new TranscriptService({ homeDir: home, core: coldCore() });
      try {
        const cold = await reopened.readColdSnapshot('s1', 'child');
        expect(cold).toMatchObject({ items: [], toolCallCountKnown: false, hasMoreOlder: true });
        const page = await readSessionViewTranscriptPage(reopened, 's1', { agentId: 'child' });
        expect(page?.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
        expect((await reopened.getAgentToolCallCounts('s1', ['child'])).has('child')).toBe(false);
      } finally {
        reopened.dispose();
      }
    } finally {
      resetUnexpectedErrorHandler();
      ix.dispose();
      wireLog.dispose();
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('does not certify empty legacy wires or an overwritten sealed wire after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-proof-'));
    const service = new TranscriptService({ homeDir: home, core: coldCore() });
    try {
      const emptyDir = join(home, 'sessions', 'ws', 's1', 'agents', 'empty');
      await mkdir(emptyDir, { recursive: true });
      await writeFixtureFile(join(emptyDir, 'wire.jsonl'), '');
      expect(await service.readColdSnapshot('s1', 'empty')).toMatchObject({
        items: [], toolCallCountKnown: false, hasMoreOlder: true,
      });
      const legacyDir = join(home, 'sessions', 'ws', 's1', 'agents', 'legacy');
      await mkdir(legacyDir, { recursive: true });
      const wirePath = join(legacyDir, 'wire.jsonl');
      const original = `${JSON.stringify({ type: 'turn.prompt', turnId: 0, promptId: 'p', input: [{ type: 'text', text: 'a' }], origin: { kind: 'user' } })}\n`;
      await writeFixtureFile(wirePath, original);
      const unknown = { toolCallCountKnown: false, hasMoreOlder: true };
      expect(await service.readColdSnapshot('s1', 'legacy')).toMatchObject({
        ...unknown, items: [expect.objectContaining({ kind: 'turn', prompt: 'a' })],
      });
      await writeFixtureFile(join(legacyDir, WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({
        format: 1, epoch: 'interrupted', state: 'open', trusted: true,
      }));
      expect(await service.readColdSnapshot('s1', 'legacy')).toMatchObject(unknown);
      await sealFixtureWire(wirePath);
      expect(await service.readColdSnapshot('s1', 'legacy')).toMatchObject({
        items: [expect.objectContaining({ kind: 'turn', prompt: 'a' })],
        toolCallCountKnown: true, hasMoreOlder: false,
      });
      await writeFixtureFile(wirePath, original.replace('"text":"a"', '"text":"b"'));
      expect(await service.readColdSnapshot('s1', 'legacy')).toMatchObject({
        ...unknown, items: [expect.objectContaining({ kind: 'turn', prompt: 'b' })],
      });
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('bounds the unverified quarantine and still rejects reads after an oversized resident turn is released', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const warnings: string[] = [];
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      logger: { warn: (_details, message) => warnings.push(message) },
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const failedWire = stubAgentWire(async () => { throw new Error('append failed'); });
      const child = agents.add('oversized', { wire: failedWire });
      child.bus.emit(ev({
        type: 'turn.prompt', turnId: 0, promptId: 'huge',
        input: [{ type: 'text', text: 'x'.repeat(2_200_000) }], origin: { kind: 'user' }, time: 1_000,
      }));
      child.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 }));
      expect(store.getAgent('oversized')?.residentReport().estimatedBytes).toBeGreaterThan(4 << 20);
      agents.remove('oversized');
      expect(service.getUnverifiedAgentSnapshot('s1', 'oversized')).toBeUndefined();
      expect(service.memoryReport()).toMatchObject({ unverifiedResidentAgents: 0, unverifiedResidentBytes: 0 });
      await expect(service.ensureAgentHistory('s1', 'oversized')).rejects.toThrow('not verified against durable history');
      expect(warnings).toContain('transcript: unverified resident history exceeds quarantine budget');
      for (let index = 0; index < 17; index += 1) {
        const agentId = `small-${index}`;
        const small = agents.add(agentId, { wire: failedWire });
        small.bus.emit(ev({
          type: 'turn.prompt', turnId: 0, promptId: `prompt-${index}`,
          input: [{ type: 'text', text: 'saved for diagnostics' }], origin: { kind: 'user' }, time: 3_000 + index,
        }));
        agents.remove(agentId);
      }
      expect(service.memoryReport().unverifiedResidentAgents).toBe(16);
      expect(service.getUnverifiedAgentSnapshot('s1', 'small-0')).toBeUndefined();
      expect(service.getUnverifiedAgentSnapshot('s1', 'small-16')).toMatchObject({ complete: false });
      await expect(service.ensureAgentHistory('s1', 'small-0')).rejects.toThrow('not verified against durable history');
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

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

  it.each(['s1', 'unrelated-session', 'service-dispose'])('scopes cold receipt verification cancellation independently of live eviction (%s)', async (evictedSessionId) => {
    const home = await seedWireHomeWithTool();
    const originalDigest = transcriptReceipt.digestWireBytes;
    let release!: () => void;
    let hashingFinished!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hashing = new Promise<void>((resolve) => { hashingFinished = resolve; });
    const digest = vi.spyOn(transcriptReceipt, 'digestWireBytes').mockImplementation(async (source) => {
      const result = await originalDigest(source);
      hashingFinished();
      await held;
      return result;
    });
    const service = new TranscriptService({ homeDir: home, core: coldCore() });
    try {
      const read = service.readColdSnapshot('s1', 'main');
      await hashing;
      if (evictedSessionId === 'service-dispose') service.dispose();
      else service.dropSession(evictedSessionId);
      release();
      if (evictedSessionId === 'service-dispose') await expect(read).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(read).resolves.toMatchObject({ toolCallCountKnown: true, toolCallCount: 1 });
    } finally {
      release();
      service.dispose();
      digest.mockRestore();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] memoizes sealed receipt verification without rehashing an unchanged wire', async () => {
    const home = await seedWireHomeWithTool();
    const digest = vi.spyOn(transcriptReceipt, 'digestWireBytes');
    let service: TranscriptService | undefined;
    try {
      service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
      });
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(1);
      const firstHashes = digest.mock.calls.length;
      expect(firstHashes).toBeGreaterThan(0);
      expect((await service.getAgentToolCallCounts('s1', ['main'])).get('main')).toBe(1);
      expect(digest.mock.calls.length).toBe(firstHashes);
    } finally {
      service?.dispose();
      digest.mockRestore();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('[STAT-R1] rejects a sealed wire before hashing when validation plus replay exceeds the byte budget', async () => {
    const home = await seedWireHomeWithTool();
    const digest = vi.spyOn(transcriptReceipt, 'digestWireBytes');
    const metrics = { reads: 0, bytes: 0 };
    let service: TranscriptService | undefined;
    try {
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const wireSize = (await fsPromises.readFile(wirePath)).byteLength;
      service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
        toolCallCountLimits: { maxBytesPerRequest: wireSize, maxFilesPerRequest: 8 },
        toolCallCountReader: measuredReader(metrics),
      });
      expect((await service.getAgentToolCallCounts('s1', ['main'])).has('main')).toBe(false);
      expect(digest).not.toHaveBeenCalled();
      expect(metrics.reads).toBe(0);
      expect(metrics.bytes).toBe(0);
    } finally {
      service?.dispose();
      digest.mockRestore();
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
        const known = false;
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

  it('[STAT-R3] rejects zero-byte wire proofs but counts zero tools in a sealed nonempty wire', async () => {
    const scenarios = [
      { name: 'missing', content: undefined, expectedKnown: false },
      { name: 'corrupt', content: '{"type":"turn.prompt"}\nnot-json\n', expectedKnown: false },
      { name: 'empty', content: '', expectedKnown: false },
      { name: 'sealed-empty', content: '', expectedKnown: false },
      { name: 'sealed-no-tools', content: `${JSON.stringify({
        type: 'turn.prompt', turnId: 0, promptId: 'p',
        input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' },
      })}\n`, expectedKnown: true },
    ] as const;
    for (const scenario of scenarios) {
      const home = await mkdtemp(join(tmpdir(), `transcript-count-${scenario.name}-`));
      try {
        const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
        await mkdir(wireDir, { recursive: true });
        const wirePath = join(wireDir, 'wire.jsonl');
        if (scenario.content !== undefined) {
          if (scenario.name.startsWith('sealed-')) await writeFile(wirePath, scenario.content);
          else await writeFixtureFile(wirePath, scenario.content);
        }
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

  it('keeps a newer live running phase when backfilling an older ended snapshot', async () => {
    const home = await seedWireHome(undefined, true);
    try {
      const agents = new FakeAgents();
      const main = agents.add('main', { loopStatus: { state: 'running', activeTurnId: 1 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      });
      const store = service.forSessionLive('s1')!;
      const transcript = store.ensureAgent('main');
      main.bus.emit(ev({ type: 'turn.started', time: 3_000, turnId: 1, origin: { kind: 'user' } }));
      transcript.apply([{ op: 'meta.merge', meta: {
        agent: { phase: { kind: 'running', turnId: 1, step: 0, stepId: '', since: 3_000 } },
      } }]);
      expect(transcript.snapshot().meta.agent?.phase).toMatchObject({ kind: 'running', turnId: 1 });
      await service.whenReady('s1');
      expect(transcript.getTurn('t1')?.state).toBe('running');
      expect(transcript.snapshot().meta).toMatchObject({
        activity: 'turn', agent: { phase: { kind: 'running', turnId: 1 } },
      });
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
    it('reuses consecutive cold pages only while the wire fingerprint matches', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const scans: string[] = [];
      const service = new TranscriptService({
        homeDir: home,
        core: coldCore(),
        wireRecordReader: async (path, options) => {
          scans.push(path);
          return streamWireRecords(path, options);
        },
      });
      try {
        await appendFile(wirePath, `${Array.from({ length: 44 }, (_, index) => JSON.stringify({
          type: 'turn.prompt', turnId: index + 1, promptId: `prompt-${index + 1}`,
          input: [{ type: 'text', text: `question ${index + 1}` }], origin: { kind: 'user' }, time: 6_000 + index,
        })).join('\n')}\n`);
        const first = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
        const second = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't25' });
        expect(first?.items.filter((item) => item.kind === 'turn')).toHaveLength(20);
        expect(second?.items.filter((item) => item.kind === 'turn')).toHaveLength(20);
        expect(scans).toHaveLength(1);
        await appendFile(wirePath, `${JSON.stringify({
          type: 'turn.prompt', turnId: 45, promptId: 'later',
          input: [{ type: 'text', text: 'new fact' }], origin: { kind: 'user' }, time: 10_000,
        })}\n`);
        const changed = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
        expect(scans).toHaveLength(2);
        expect(changed?.items.some((item) => item.kind === 'turn' && item.turnId === 't45')).toBe(true);
        const expiredAt = Date.now() + 16_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
        try {
          await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't26' });
          expect(scans).toHaveLength(3);
        } finally { clock.mockRestore(); }
      } finally {
        service.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('does not cache oversized consecutive cold pages above the bounded memory budget', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const large = 'x'.repeat(50_000);
      await appendFile(wirePath, `${Array.from({ length: 90 }, (_, index) => JSON.stringify({
        type: 'turn.prompt', turnId: index + 1, promptId: `large-${index}`,
        input: [{ type: 'text', text: large }], origin: { kind: 'user' }, time: 6_000 + index,
      })).join('\n')}\n`);
      let scans = 0;
      const service = new TranscriptService({
        homeDir: home, core: coldCore(),
        wireRecordReader: async (path, options) => {
          scans += 1;
          return streamWireRecords(path, options);
        },
      });
      try {
        const size = (await fsPromises.stat(wirePath)).size;
        const first = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
        const second = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't71' });
        expect(size).toBeGreaterThan(4 << 20);
        expect(first?.items).toHaveLength(20);
        expect(second?.items).toHaveLength(20);
        expect(first?.coverage.kind).toBe('tail');
        expect(second?.coverage.kind).toBe('tail');
        expect(scans).toBe(2);
      } finally {
        service.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

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

    it('skips checkpoint reads and construction for a sealed wire over 8 MiB', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const core = fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents());
      const query = core.accessor.get(IQueryStore);
      const get = vi.spyOn(query, 'get');
      const put = vi.spyOn(query, 'put');
      const draftCheckpoint = vi.spyOn(AgentTranscriptDraft.prototype, 'checkpoint');
      const adapterCheckpoint = vi.spyOn(TranscriptWireAdapter.prototype, 'checkpoint');
      const records = Array.from({ length: 300 }, (_, index) =>
        JSON.stringify({ type: 'executor.runtime.update', kind: 'stable', index }));
      await appendFile(wirePath, `${records.join('\n')}\n${JSON.stringify({ type: 'turn.prompt', turnId: 2,
        promptId: 'large-prompt', origin: { kind: 'user' },
        input: [{ type: 'text', text: `large-visible-${'x'.repeat(8 << 20)}` }] })}\n`);
      const service = new TranscriptService({ homeDir: home, core });
      try {
        const snapshot = await service.readColdSnapshot('s1', 'main');
        expect(snapshot?.items.some((item) => item.kind === 'turn' && item.turnId === 't2')).toBe(true);
        expect(get.mock.calls.filter(([collection]) => collection === '__transcript_projection_checkpoint__')).toHaveLength(0);
        expect(put.mock.calls.filter(([collection]) => collection === '__transcript_projection_checkpoint__')).toHaveLength(0);
        expect(draftCheckpoint).toHaveBeenCalledTimes(1); // The full GUI snapshot still materializes once.
        expect(adapterCheckpoint).not.toHaveBeenCalled();
      } finally {
        service.dispose();
        get.mockRestore(); put.mockRestore(); draftCheckpoint.mockRestore(); adapterCheckpoint.mockRestore();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('skips checkpoint construction when no query store exists', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      await appendFile(wirePath, `${Array.from({ length: 300 }, (_, index) =>
        JSON.stringify({ type: 'executor.runtime.update', kind: 'stable', index })).join('\n')}\n`);
      const draftCheckpoint = vi.spyOn(AgentTranscriptDraft.prototype, 'checkpoint');
      const service = new TranscriptService({ homeDir: home, core: coldCore() });
      try {
        expect((await service.readColdSnapshot('s1', 'main'))?.items.length).toBeGreaterThan(0);
        expect(draftCheckpoint).toHaveBeenCalledTimes(1); // Required once by snapshot().
      } finally {
        service.dispose(); draftCheckpoint.mockRestore();
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

    it('does not reconstruct or rewrite an unchanged verified projection checkpoint', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      await appendFile(wirePath, `${Array.from({ length: 300 }, (_, index) =>
        JSON.stringify({ type: 'executor.runtime.update', kind: 'stable', index })).join('\n')}\n`);
      const core = fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents());
      const put = vi.spyOn(core.accessor.get(IQueryStore), 'put');
      const adapterCheckpoint = vi.spyOn(TranscriptWireAdapter.prototype, 'checkpoint');
      const starts: (number | undefined)[] = [];
      const services: TranscriptService[] = [];
      const read = async () => {
        const service = new TranscriptService({
          homeDir: home, core,
          wireRecordReader: async (path, options) => {
            starts.push(options.startByteOffset);
            return streamWireRecords(path, options);
          },
        });
        services.push(service);
        try { return await service.readColdSnapshot('s1', 'main'); }
        finally { service.dispose(); }
      };
      try {
        const expected = await read();
        const offset = (await fsPromises.stat(wirePath)).size;
        expect(await read()).toEqual(expected);
        expect(starts).toEqual([undefined, offset]);
        expect(put.mock.calls.filter(([collection]) => collection === '__transcript_projection_checkpoint__')).toHaveLength(1);
        expect(adapterCheckpoint).toHaveBeenCalledTimes(1);
        await appendFile(wirePath, `${JSON.stringify({ type: 'turn.prompt', turnId: 1,
          input: [{ type: 'text', text: 'appended fact' }], origin: { kind: 'user' }, time: 10 })}\n`);
        expect((await read())?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
        expect(put.mock.calls.filter(([collection]) => collection === '__transcript_projection_checkpoint__')).toHaveLength(2);
        expect(adapterCheckpoint).toHaveBeenCalledTimes(2);
        await appendFile(wirePath, '\n\n');
        const afterAppend = await read();
        expect(await read()).toEqual(afterAppend);
        expect(starts.at(-1)).toBe((await fsPromises.stat(wirePath)).size);
        expect(put.mock.calls.filter(([collection]) => collection === '__transcript_projection_checkpoint__')).toHaveLength(3);
      } finally {
        for (const service of services) service.dispose();
        put.mockRestore(); adapterCheckpoint.mockRestore();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it.each([1, 2, 3])('rebuilds projection checkpoint format %s to recover current wire facts', async (format) => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      await appendFile(wirePath, `${[
        { type: 'turn.prompt', turnId: 1, origin: { kind: 'other' }, time: 10_000 },
        { type: 'turn.step.retrying', turnId: 1, step: 1, failedAttempt: 2, nextAttempt: 3,
          maxAttempts: 5, delayMs: 100, errorName: 'APIConnectionError', errorMessage: 'Connection closed', time: 11_000 },
        { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: 12_000 },
        { type: 'profile.bind', modelAlias: 'example/old', time: 13_000 },
        { type: 'config.update', modelAlias: 'example/new', time: 14_000 },
      ].map((record) => JSON.stringify(record)).join('\n')}\n`);
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
        const recoveredTurn = expected?.items.find((item) => item.kind === 'turn' && item.turnId === 't1');
        expect(recoveredTurn).toMatchObject({ state: 'cancelled' });
        expect(recoveredTurn?.kind === 'turn' && recoveredTurn.steps.find((step) => step.retry !== undefined)?.retry)
          .toMatchObject({ failedAttempt: 2, nextAttempt: 3, maxAttempts: 5, delayMs: 100,
            errorName: 'APIConnectionError', errorMessage: 'Connection closed' });
        expect(expected?.items.filter((item) => item.kind === 'marker' && item.marker === 'model.switch')).toEqual([
          expect.objectContaining({ payload: { from: 'example/old', to: 'example/new' } }),
        ]);
        expect(checkpoint?.format).toBe(4);
        await query.put('__transcript_projection_checkpoint__', key, {
          ...checkpoint, format,
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
      expect(snapshots[2]?.items).toEqual(snapshots[0]?.items);
      expect(snapshots[2]).toMatchObject({ toolCallCountKnown: false, hasMoreOlder: true });
      expect(snapshots[2]?.toolCallCount).toBeUndefined();
    });

    it.each([
      { name: 'the transcript page', path: '/sessions/:session_id/transcript', query: { agent_id: 'main', transcript_coverage_version: '2' } },
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
    it('assigns consecutive per-agent seqs and serves catch-up from the journal (b142f9aaa9 durable/live terminal batches)', async () => {
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

  describe('prompt queue reconciliation', () => {
    async function seedPromptReplayWire(): Promise<string> {
      const home = await mkdtemp(join(tmpdir(), 'transcript-prompts-'));
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const records: Record<string, unknown>[] = [
        {
          type: 'prompt.enqueued',
          promptId: 'agent-msg-1',
          userMessageId: 'agent-msg-1',
          queueIndex: 0,
          revision: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          message: {
            id: 'agent-msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'from subagent' }],
            origin: { kind: 'agent_message', messageId: 'agent-msg-1', senderAgentId: 'agent-9' },
          },
          time: 1_000,
        },
        {
          type: 'prompt.enqueued',
          promptId: 'msg_steered',
          userMessageId: 'msg_steered',
          queueIndex: 0,
          revision: 0,
          createdAt: '2026-01-01T00:00:01.000Z',
          message: {
            id: 'msg_steered',
            role: 'user',
            content: [{ type: 'text', text: 'steer me' }],
            origin: { kind: 'user' },
          },
          time: 1_001,
        },
        {
          type: 'prompt.enqueued',
          promptId: 'msg_orphan',
          userMessageId: 'msg_orphan',
          queueIndex: 1,
          revision: 0,
          createdAt: '2026-01-01T00:00:02.000Z',
          message: {
            id: 'msg_orphan',
            role: 'user',
            content: [{ type: 'text', text: 'orphan' }],
            origin: { kind: 'user' },
          },
          time: 1_002,
        },
        {
          type: 'prompt.steered',
          activePromptId: 'agent-msg-1',
          promptIds: ['msg_steered'],
          content: [{ type: 'text', text: 'steer me' }],
          steeredAt: '2026-01-01T00:00:03.000Z',
          time: 1_003,
        },
      ];
      await writeFile(
        join(wireDir, 'wire.jsonl'),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
      return home;
    }

    it('settles cold-replayed queued prompts the engine no longer owns', async () => {
      const home = await seedPromptReplayWire();
      try {
        const agents = new FakeAgents();
        agents.add('main', { loopStatus: { state: 'idle' }, prompts: { pending: [] } });
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        });
        const store = service.forSessionLive('s1');
        await service.whenReady('s1');

        const transcript = store?.getAgent('main');
        expect(transcript?.getPrompt('msg_steered')).toMatchObject({
          status: 'completed',
          steeredAt: '2026-01-01T00:00:03.000Z',
        });
        expect(transcript?.getPrompt('msg_orphan')).toMatchObject({
          status: 'aborted',
          abortedBeforeStart: true,
        });
        expect(transcript?.getPrompt('agent-msg-1')).toBeUndefined();
        service.dropSession('s1');
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('keeps a recovered engine-pending queue while settling stale replay prompts', async () => {
      const home = await seedPromptReplayWire();
      try {
        const agents = new FakeAgents();
        agents.add('main', {
          loopStatus: { state: 'idle' },
          prompts: {
            pending: [
              {
                id: 'msg_recovered',
                userMessageId: 'msg_recovered',
                createdAt: '2026-01-01T00:00:04.000Z',
                state: 'pending',
                message: { role: 'user', content: [{ type: 'text', text: 'recovered' }] },
                revision: 1,
              },
            ],
          },
        });
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
        });
        const store = service.forSessionLive('s1');
        await service.whenReady('s1');

        const transcript = store?.getAgent('main');
        expect(transcript?.getPrompt('msg_recovered')).toMatchObject({ status: 'queued' });
        expect(transcript?.getPrompt('msg_steered')).toMatchObject({
          status: 'completed',
          steeredAt: '2026-01-01T00:00:03.000Z',
        });
        expect(transcript?.getPrompt('msg_orphan')).toMatchObject({
          status: 'aborted',
          abortedBeforeStart: true,
        });
        service.dropSession('s1');
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });
  });
});
