import { appendFile as appendFixtureFile, mkdtemp, mkdir, rm, writeFile as writeFixtureFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NOTE_SECTIONS } from '@kiki/agent-core-v2/session/todo/todoNotes';

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
  applyContentSegment,
  jsonBytes,
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
  type TranscriptWireAdapterCheckpoint,
} from '@kiki/transcript';
import { describe, expect, it, vi } from 'vitest';

import { descriptorFromMeta, streamWireRecords, type LiveAdapterBusEvent } from '@kiki/transcript-live';

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
import { HistoryNavigationDb } from '../../src/services/history/historyNavigationDb';
import { HistoryLocatorStore } from '../../src/services/history/historyLocatorStore';
import { CanonicalEntityPreparingError } from '../../src/services/history/historyCanonicalReader';
import { HistoryResidentProof } from '../../src/services/history/historyResidentProof';
import { registerTranscriptRoutes } from '../../src/routes/transcript';
import { readColdSessionViewBaseline, readSessionViewCanonicalEntity, readSessionViewTranscriptContent, readSessionViewTranscriptDetail, readSessionViewTranscriptDetails, readSessionViewTranscriptPage } from '../../src/transport/klient/sessionViewReads';
import { TestInstantiationService } from '../../../agent-core-v2/src/_base/di/test';
import { SyncDescriptor } from '../../../agent-core-v2/src/_base/di/descriptors';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '../../../agent-core-v2/src/_base/errors/unexpectedError';
import { InMemoryStorageService } from '../../../agent-core-v2/src/persistence/backends/memory/inMemoryStorageService';
import { FileStorageService } from '../../../agent-core-v2/src/persistence/backends/node-fs/fileStorageService';
import { AppendLogStore } from '../../../agent-core-v2/src/persistence/backends/node-fs/appendLogStore';
import { noopTelemetryService } from '../../../agent-core-v2/src/app/telemetry/telemetry';
import { noopLogger, registerTestAgentWire, stubAgentWire } from '../../../agent-core-v2/test/wire/stubs';
import { WIRE_TRANSCRIPT_RECEIPT_KEY, digestWireBytes, parseWireTranscriptReceipt } from '../../../agent-core-v2/src/wire/transcriptReceipt';
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
  it('exposes only the resident and detail cache limits consumed by TranscriptService', () => {
    expect(DEFAULT_TRANSCRIPT_MEMORY_CONFIG).toEqual({
      tailTurns: 20,
      maxAgentBytes: 16 << 20,
      maxDetailCacheBytes: 256 << 20,
    });
    expect(TranscriptMemoryConfigSchema.parse(DEFAULT_TRANSCRIPT_MEMORY_CONFIG)).toEqual(
      DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
    );
    expect(TranscriptMemoryConfigSchema.parse({ maxDetailCacheBytes: 0 })).toEqual({ maxDetailCacheBytes: 0 });
    expect(TranscriptMemoryConfigSchema.parse({ maxDetailCacheBytes: Number.MAX_SAFE_INTEGER })).toEqual({ maxDetailCacheBytes: Number.MAX_SAFE_INTEGER });
    for (const maxDetailCacheBytes of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(TranscriptMemoryConfigSchema.safeParse({ maxDetailCacheBytes }).success).toBe(false);
    }
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
  it('projects persisted births identically for live and closed cold rosters without legacy backfill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-birth-'));
    const meta = { agents: { child: { type: 'sub' as const, createdAt: 1234 }, legacy: { type: 'sub' as const } } };
    await mkdir(join(home, 'sessions', 'ws', 's1'), { recursive: true });
    await writeFile(join(home, 'sessions', 'ws', 's1', 'state.json'), JSON.stringify(meta));
    const service = new TranscriptService({ core: coldCore(), homeDir: home });
    try {
      const cold = await service.readColdRoster('s1');
      expect(cold).toEqual(Object.entries(meta.agents).map(([id, agent]) => descriptorFromMeta(id, agent)));
      expect(cold?.find((agent) => agent.agentId === 'child')?.createdAt).toBe(new Date(1234).toISOString());
      expect(cold?.find((agent) => agent.agentId === 'legacy')?.createdAt).toBeUndefined();
      cold?.push({ agentId: 'caller-added', type: 'sub' });
      expect(await service.readColdRoster('s1')).toHaveLength(2);
      await writeFile(join(home, 'sessions', 'ws', 's1', 'state.json'), JSON.stringify({ agents: { ...meta.agents, later: { type: 'sub' } } }));
      expect((await service.readColdRoster('s1'))?.map((agent) => agent.agentId)).toEqual(['child', 'legacy', 'later']);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
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
          if (token === ISessionMetadata) return { ready: Promise.resolve(), snapshot: () => ({ agents: {} }), read: async () => ({ agents: {} }) };
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

  it('reads verified resident canonical tools and frames without a cold read or navigation preparation', async () => {
    const home = await seedWireHome();
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({ homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const transcript = store.ensureAgent('main');
      transcript.apply([
        { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't100', ordinal: 100, state: 'running', origin: { kind: 'user' } } },
        { op: 'step.upsert', turnId: 't100', step: { kind: 'step', stepId: 'resident-step', turnId: 't100', ordinal: 1, state: 'running' } },
        { op: 'frame.upsert', turnId: 't100', stepId: 'resident-step', frame: { kind: 'tool', frameId: 'resident-frame',
          toolCallId: 'resident-call', name: 'Example', state: 'running', input: { exact: true },
          display: { type: 'diff', content: 'complete' }, progress: { kind: 'progress', percent: 50 } } },
      ]);
      const cold = vi.spyOn(service, 'readColdSnapshot');
      const navigation = vi.fn(() => { throw new Error('navigation should not be called'); });
      service.setHistoryLocatorReader(navigation);
      const hit = await service.lookupToolCall('s1', 'main', 'resident-call');
      expect(hit).toEqual({ status: 'found', ...transcript.getToolCall('resident-call') });
      expect(await service.readCanonicalEntity('s1', 'main', { kind: 'frame', id: 'resident-frame', turnId: 't100', stepId: 'resident-step' }))
        .toBe(transcript.getToolCall('resident-call')?.frame);
      expect(await service.readCanonicalEntity('s1', 'main', { kind: 'turn', id: 't100' })).toBe(transcript.getTurn('t100'));
      expect(cold).not.toHaveBeenCalled();
      expect(navigation).not.toHaveBeenCalled();
      const cancelled = new AbortController(); cancelled.abort();
      await expect(service.lookupToolCall('s1', 'main', 'resident-call', cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { service.dispose(); await rm(home, { recursive: true, force: true }); }
  });

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
      const notesFor = (agentId: string): Record<string, string> => ({ ...Object.fromEntries(NOTE_SECTIONS.map((section) => [section, `${agentId}:${section}:sentinel\nfull text`])), future_section: 'New field exact text' });
      for (const handle of [main, child]) {
        const notes = notesFor(handle.id);
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
        expect(events.some((event) => event.agentId === handle.id && event.ops.some((op) => op.op === 'todo.upsert' && op.todo.notes?.goal === notes['goal']))).toBe(true);
        const livePage = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(service, 's1', { agentId: handle.id }));
        expect(livePage.todos).toEqual([expect.objectContaining({ todoId: 'todo', notes, notesMeta })]);
      }
      service.dispose();
      for (const agentId of ['main', 'child-notes']) {
        const page = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(cold, 's1', { agentId }));
        expect(page.todos[0]?.notes).toEqual(notesFor(agentId));
        expect(page.todos[0]?.notesMeta?.rev).toBe(1);
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
      expect((await readSessionViewTranscriptPage(cold, 's1', { agentId: 'main' }))?.todos[0]?.notes).toEqual(notesFor('main'));
      const invalid = { type: 'tools.update_store', key: 'todo_notes', value: { notes: { future_section: 42 } }, time: 7000 };
      await appendFile(join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl'), `${JSON.stringify(invalid)}\n`);
      const degraded = transcriptResponseSchema.parse(await readSessionViewTranscriptPage(cold, 's1', { agentId: 'main' }));
      expect(degraded.todos[0]?.notes).toEqual(notesFor('main'));
      expect(degraded.todos[0]?.notesStatus).toMatchObject({ state: 'incompatible', schemaVersion: 1, fields: ['notes.future_section'] });
      const baseline = transcriptResetPayloadSchema.parse(await readColdSessionViewBaseline(cold, 's1', 'main', 'delta', new AbortController().signal));
      expect(baseline.snapshot.todos).toEqual(degraded.todos);
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
        await ix.dispose();
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
      await ix.dispose();
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
      await ix.dispose();
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
      await ix.dispose();
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

  it('waits for flush before releasing completed live tool turns and reads late results from history', async () => {
    const home = await seedWireHome(undefined, true);
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    let releaseFlush!: () => void;
    const flushing = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const wire = { ...stubAgentWire(), flush: vi.fn(async () => flushing) };
    const agents = new FakeAgents();
    const main = agents.add('main', { wire });
    const service = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents), residentLimits: { tailTurns: 1, maxBytes: 3 << 20 } });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      for (let turnId = 1; turnId <= 3; turnId += 1) {
        const records = [
          { type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: 'read' }], origin: { kind: 'user' }, time: turnId * 2_000 + 1_000 },
          { type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: `s${turnId}` } },
          { type: 'context.append_loop_event', event: { type: 'tool.call', turnId, stepUuid: `s${turnId}`, uuid: `f${turnId}`, toolCallId: `c${turnId}`, name: 'Read', args: { path: `file${turnId}` } } },
          { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${turnId}`, result: { output: 'x'.repeat(1 << 20), isError: false } } },
          { type: 'turn.ended', turnId, reason: 'completed', time: turnId * 2_000 + 2_000 },
        ];
        await appendFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        for (const record of records) main.bus.emit(ev(record));
      }
      expect(store.getAgent('main')?.getTurn('t1')).toBeDefined();
      expect(service.memoryReport().residentTurns).toBe(4);
      releaseFlush();
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t1')).toBeUndefined());
      expect(service.memoryReport().residentBytes).toBeLessThan(3 << 20);
      const late = { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'c1', result: { output: 'late result', isError: false } } };
      await appendFile(wirePath, `${JSON.stringify(late)}\n`);
      main.bus.emit(ev(late));
      const cold = await service.readColdSnapshot('s1');
      const old = cold?.items.find((item) => item.kind === 'turn' && item.turnId === 't1');
      expect(old).toMatchObject({ steps: [expect.objectContaining({ frames: [expect.objectContaining({ toolCallId: 'c1', input: { path: 'file1' }, output: 'late result' })] })] });
      const older = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't2', pageSize: 1 });
      expect(older?.items[0]).toMatchObject({ kind: 'turn', turnId: 't1' });
      expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(3);
    } finally {
      releaseFlush();
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('bounds a durable main history while keeping old pages and a new in-flight reply readable', async () => {
    const home = await seedWireHome(undefined, true);
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    const records = Array.from({ length: 80 }, (_, index) => [
      { type: 'turn.prompt', turnId: index + 1, promptId: `large-${index}`, input: [{ type: 'text', text: `${index}:${'x'.repeat(256 << 10)}` }], origin: { kind: 'user' }, time: 3_000 + index * 2_000 },
      { type: 'turn.ended', turnId: index + 1, reason: 'completed', time: 4_000 + index * 2_000 },
    ]).flat();
    await appendFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const agents = new FakeAgents();
    const main = agents.add('main');
    const service = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      console.log('[main-resident]', service.memoryReport().residentBytes);
      expect(service.memoryReport().residentBytes).toBeLessThan(16 << 20);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't2', pageSize: 1, signal: cancelled.signal })).rejects.toThrow();
      const older = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't2', pageSize: 1 });
      expect(older?.items[0]).toMatchObject({ kind: 'turn', turnId: 't1' });
      const oldest = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't1', pageSize: 1 });
      expect(oldest?.items.find((item) => item.kind === 'turn')).toMatchObject({ turnId: 't0' });
      expect(oldest?.has_more).toBe(false);
      expect(oldest?.next_cursor).toBeUndefined();
      for (let step = 0; step < 6; step += 1) {
        await service.readColdPageSnapshot('s1', 'main', (source) => source, undefined, true, 8 << 20);
      }
      expect(service.memoryReport().coldWindowEntries).toBeLessThanOrEqual(4);
      expect(service.memoryReport().coldWindowBytes).toBeLessThanOrEqual(8 << 20);
      expect((await service.readColdSnapshot('s1'))?.items.find((item) => item.kind === 'turn' && item.turnId === 't1')).toMatchObject({ prompt: `0:${'x'.repeat(256 << 10)}` });
      main.bus.emit(ev({ type: 'turn.prompt', turnId: 81, promptId: 'in-flight', input: [{ type: 'text', text: 'still running' }], origin: { kind: 'user' }, time: 200_000 }));
      main.bus.emit(ev({ type: 'turn.step.started', turnId: 81, stepId: 's81', step: 1, time: 200_001 }));
      main.bus.emit(ev({ type: 'assistant.delta', turnId: 81, stepId: 's81', step: 1, delta: 'reply survives', time: 200_002 }));
      expect(store.getAgent('main')?.getTurn('t81')).toMatchObject({ state: 'running', prompt: 'still running', steps: [expect.objectContaining({ frames: [expect.objectContaining({ text: 'reply survives' })] })] });
      const full = await service.ensureAgentHistory('s1', 'main', { fullHistory: true });
      expect(full?.getTurn('t1')?.prompt).toBe(`0:${'x'.repeat(256 << 10)}`);
      expect(full?.getTurn('t81')?.state).toBe('running');
      expect(service.memoryReport().residentBytes).toBeLessThan(16 << 20);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('bounds aggregate live history across 220 agents and two sessions without losing old or active turns', async () => {
    const home = await seedWireHome(undefined, true);
    const rosters = [new FakeAgents(), new FakeAgents()];
    const interactions = rosters.map(() => new SessionInteractionService(new TestSessionStateService()));
    const sessions = rosters.map((agents, index) => fakeSession(interactions[index]!, agents));
    const base = fakeCoreWithAgents(interactions[0]!, rosters[0]!);
    const core = { accessor: { get: (token: unknown) => token === ISessionManager
      ? { get: (id: string) => sessions[Number(id.slice(1)) - 1], list: () => sessions }
      : base.accessor.get(token as never) } } as unknown as Scope;
    let holdReads = false;
    const service = new TranscriptService({ homeDir: home, core, wireRecordReader: async (path, options) => {
      if (holdReads) await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return streamWireRecords(path, options);
    } });
    const samples: { agents: number; retained: number; heap: number }[] = [];
    try {
      for (let s = 0; s < 2; s += 1) {
        const sessionId = `s${s + 1}`;
        rosters[s]!.add('main');
        const mainPath = join(home, 'sessions/ws', sessionId, 'agents/main/wire.jsonl');
        await mkdir(dirname(mainPath), { recursive: true });
        await writeFile(mainPath, `${JSON.stringify({ type: 'turn.prompt', turnId: 0, promptId: 'main-active', input: [{ type: 'text', text: 'Main remains active' }], origin: { kind: 'user' } })}\n`);
        service.forSessionLive(sessionId);
        await service.whenReady(sessionId);
        for (let n = 0; n < 110; n += 1) {
          const agentId = `child-${n}`;
          const wirePath = join(home, 'sessions/ws', sessionId, 'agents', agentId, 'wire.jsonl');
          await mkdir(dirname(wirePath), { recursive: true });
          await writeFile(wirePath, [
            { type: 'turn.prompt', turnId: 0, promptId: `p-${n}`, input: [{ type: 'text', text: `${sessionId}:${n}:${'x'.repeat(512 << 10)}` }], origin: { kind: 'user' }, time: 1000 },
            { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2000 },
          ].map(record => JSON.stringify(record)).join('\n') + '\n');
          rosters[s]!.add(agentId);
          await service.ensureAgentHistory(sessionId, agentId);
          vi.mocked(writeFixtureFile).mockClear();
          vi.mocked(fsPromises.readFile).mockClear();
          if (n % 25 === 24 || n === 109) {
            globalThis.gc?.();
            samples.push({ agents: s * 110 + n + 1, retained: service.memoryReport().residentBytes, heap: process.memoryUsage().heapUsed });
          }
        }
      }
      const memory = service.memoryReport();
      if (globalThis.gc !== undefined) {
        const warm = samples.filter(sample => sample.agents >= 75).map(sample => sample.heap);
        expect(Math.max(...warm) - Math.min(...warm)).toBeLessThan(16 << 20);
      }
      expect(memory.liveAgents).toBeGreaterThanOrEqual(220);
      expect(memory.residentBytes).toBeLessThanOrEqual(64 << 20);
      expect(memory.coldSnapshotBytes).toBeLessThanOrEqual(4 << 20);
      expect(memory.coldWindowBytes).toBeLessThanOrEqual(32 << 20);
      const old = await readSessionViewTranscriptPage(service, 's2', { agentId: 'child-109', pageSize: 1 });
      expect(old?.items[0]).toMatchObject({ kind: 'turn', turnId: 't0' });
      const full = await service.readColdSnapshot('s2', 'child-109');
      expect((full?.items[0] as TranscriptTurn).prompt).toBe(`s2:109:${'x'.repeat(512 << 10)}`);
      expect(service.forSessionLive('s1')?.getAgent('main')?.getTurn('t0')?.prompt).toBe('Main remains active');
      holdReads = true;
      const controllers = Array.from({ length: 220 }, () => new AbortController());
      const flights = controllers.map((controller, index) => service.readColdSnapshot(`s${Math.floor(index / 110) + 1}`, `child-${index % 110}`, undefined, controller.signal).catch(error => error));
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 2, queued: 8, peak: 2 }));
      for (const controller of controllers) controller.abort();
      await Promise.all(flights);
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
      holdReads = false;
      expect((await service.readColdSnapshot('s1', 'child-0'))?.items[0]).toMatchObject({ kind: 'turn', prompt: `s1:0:${'x'.repeat(512 << 10)}` });
      service.dropSession('s1');
      service.dropSession('s2');
      expect(service.memoryReport()).toMatchObject({ liveSessions: 0, residentBytes: 0, coldWindowBytes: 0, anchorWindowEntries: 0 });
      process.stdout.write(`aggregate-agent-residency ${JSON.stringify({ samples, final: service.memoryReport(), gcAvailable: globalThis.gc !== undefined })}\n`);
    } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 120_000);

  it('bounds revisited disposed child projections while keeping historical pages readable', async () => {
    const home = await seedWireHome(undefined, true);
    const agents = new FakeAgents();
    agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
    });
    try {
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const samples: number[] = [];
      for (let index = 0; index < 24; index += 1) {
        const agentId = `child-memory-${index}`;
        const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', agentId);
        await mkdir(wireDir, { recursive: true });
        const records = [
          { type: 'turn.prompt', turnId: 0, promptId: `p-${index}`, input: [{ type: 'text', text: `${index}:${'x'.repeat(256 << 10)}` }], origin: { kind: 'user' }, time: 1_000 },
          { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 },
        ];
        await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        const page = await readSessionViewTranscriptPage(service, 's1', { agentId, pageSize: 1 });
        expect(page?.items[0]).toMatchObject({ kind: 'turn', turnId: 't0' });
        if ((index + 1) % 6 === 0) samples.push(service.memoryReport().residentBytes);
      }
      console.log('[disposed-child-resident-bytes]', samples);
      expect(samples.at(-1)).toBeLessThan(6 << 20);
      const reopened = await service.readColdSnapshot('s1', 'child-memory-0');
      expect(reopened?.items[0]).toMatchObject({ kind: 'turn', prompt: `0:${'x'.repeat(256 << 10)}` });
      expect(service.forSessionLive('s1')?.getAgent('main')?.getTurn('t0')?.prompt).toBe('hi');
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
      const reopened = await service.ensureAgentHistory('s1', 'child-healthy');
      const latest = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child-healthy', pageSize: 1 });
      const older = await readSessionViewTranscriptPage(service, 's1', {
        agentId: 'child-healthy', beforeTurn: 't1', pageSize: 1,
      });
      expect(latest?.items).toEqual([expect.objectContaining({ kind: 'turn', turnId: 't1', prompt: 'healthy-1' })]);
      expect(older?.items).toEqual([expect.objectContaining({ kind: 'turn', turnId: 't0', prompt: 'healthy-0' })]);
      const cursor = service.getTranscriptCursor('s1', 'child-healthy');
      expect(service.getOpsSince('s1', 'child-healthy', { epoch: cursor.epoch, seq: 0 })?.complete).toBe(true);
      expect(reopened?.snapshot().items.filter((item) => item.kind === 'turn')).toHaveLength(2);
      expect(store.getAgent('child-healthy')).toBeUndefined();
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('releases individually proven completed main turns beyond the tail window without trusting missing live facts', async () => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    let releaseFlush!: () => void;
    const flushing = new Promise<void>(resolve => { releaseFlush = resolve; });
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(), flush: async () => flushing,
      verifyTranscriptLiveEpoch: async () => false, isTranscriptLiveEpochVerified: () => false } });
    const service = new TranscriptService({ homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      residentLimits: { tailTurns: 1, maxBytes: 1 << 20 }, opsJournalLimits: { maxAgentBytes: 64 << 10, maxTotalBytes: 64 << 10 } });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    let store: TranscriptStore | undefined;
    const heap: Record<string, number> = {};
    try {
      store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      globalThis.gc?.(); heap['before'] = process.memoryUsage().heapUsed;
      for (let turnId = 1; turnId <= 24; turnId++) {
        const records = [
          { type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: `${turnId}:` + 'x'.repeat(512 << 10) }], origin: { kind: 'user' }, time: turnId * 2000 },
          { type: 'turn.ended', turnId, reason: 'completed', time: turnId * 2000 + 1000 },
        ];
        await appendFixtureFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
        for (const record of records) main.bus.emit(ev(record));
      }
      const mismatch = [
        { type: 'turn.prompt', turnId: 25, promptId: 'different', input: [{ type: 'text', text: 'persisted version' }], origin: { kind: 'user' }, time: 58_000 },
        { type: 'turn.ended', turnId: 25, reason: 'completed', time: 59_000 },
      ];
      await appendFixtureFile(path, mismatch.map(record => JSON.stringify(record)).join('\n') + '\n');
      main.bus.emit(ev({ ...mismatch[0], input: [{ type: 'text', text: 'unmatched live version' }] }));
      main.bus.emit(ev(mismatch[1]!));
      for (const record of [
        { type: 'turn.prompt', turnId: 26, promptId: 'missing', input: [{ type: 'text', text: 'not persisted' }], origin: { kind: 'user' }, time: 60_000 },
        { type: 'turn.ended', turnId: 26, reason: 'completed', time: 61_000 },
        { type: 'turn.prompt', turnId: 27, promptId: 'active', input: [{ type: 'text', text: 'active survives' }], origin: { kind: 'user' }, time: 62_000 },
      ]) main.bus.emit(ev(record));
      const old = new WeakRef(store.getAgent('main')!.getTurn('t1')!);
      const resident = new WeakRef(store);
      globalThis.gc?.(); heap['loaded'] = process.memoryUsage().heapUsed;
      console.log('segmented-loaded', { heap: heap['loaded'], residentBytes: service.memoryReport().residentBytes });
      releaseFlush();
      await vi.waitFor(() => expect(store?.getAgent('main')?.getTurn('t1') === undefined).toBe(true), { timeout: 15_000 });
      await vi.waitFor(() => expect(service.memoryReport().residentBytes).toBeLessThan(2 << 20), { timeout: 15_000 });
      expect(store.getAgent('main')?.getTurn('t25')).toMatchObject({ prompt: 'unmatched live version', state: 'completed' });
      expect(store.getAgent('main')?.getTurn('t26')).toMatchObject({ prompt: 'not persisted', state: 'completed' });
      expect(store.getAgent('main')?.getTurn('t27')).toMatchObject({ prompt: 'active survives', state: 'running' });
      expect(service.isTranscriptLiveCoverageVerified('s1', 'main')).toBe(false);
      if (globalThis.gc !== undefined) {
        for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
        expect(old.deref()).toBeUndefined();
      }
      heap['released'] = process.memoryUsage().heapUsed;
      const reread = await service.readCanonicalEntity('s1', 'main', { kind: 'turn', id: 't1' }, new AbortController().signal);
      expect((reread as TranscriptTurn)?.prompt).toBe('1:' + 'x'.repeat(512 << 10));
      service.dropSession('s1'); store = undefined;
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
      if (globalThis.gc !== undefined) {
        for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
        expect(resident.deref()).toBeUndefined();
      }
      heap['closed'] = process.memoryUsage().heapUsed;
      console.log('segmented-durability-release', { heap, maxRss: process.resourceUsage().maxRSS * 1024, gc: globalThis.gc !== undefined });
    } finally { releaseFlush(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 40_000);

  it('continues a live preview from its resident turn when durable history has not proven it', async () => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(),
      verifyTranscriptLiveEpoch: async () => false, isTranscriptLiveEpochVerified: () => false } });
    const service = new TranscriptService({ homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const persisted = [
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: `persisted ${'p'.repeat(40_000)}` }], origin: { kind: 'user' }, time: 3_000 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 4_000 },
      ];
      await appendFixtureFile(path, persisted.map(record => JSON.stringify(record)).join('\n') + '\n');
      const live = `live ${'l'.repeat(40_000)}`;
      main.bus.emit(ev({ ...persisted[0], input: [{ type: 'text', text: live }] }));
      main.bus.emit(ev(persisted[1]!));
      expect(store.getAgent('main')?.getTurn('t1')).toMatchObject({ prompt: live });
      const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
      let turn = page?.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === 't1');
      if (turn === undefined) throw new Error('Expected the live turn preview');
      expect(turn.contentRefs?.some(ref => ref.path[0] === 'prompt')).toBe(true);
      for (let reads = 0; turn.contentRefs?.length; reads += 1) {
        expect(reads).toBeLessThan(100);
        const segment = await readSessionViewTranscriptContent(service, 's1', { agentId: 'main', ref: turn.contentRefs[0]! });
        turn = applyContentSegment(turn, segment!);
      }
      expect(turn.prompt).toBe(live);
      const durable = (await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' }))?.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === 't1');
      const staleRef = durable?.contentRefs?.find(ref => ref.path[0] === 'prompt');
      if (staleRef === undefined) throw new Error('Expected a prompt reference');
      await expect(readSessionViewTranscriptContent(service, 's1', { agentId: 'main', ref: { ...staleRef, revision: '0'.repeat(64) } }))
        .rejects.toThrow('Content changed');
    } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it.runIf(process.env['KIKI_TRANSCRIPT_GC_FIXTURE'] === '1')('collects released payloads across fixed multi-agent rounds and rereads every completed turn', async () => {
    expect(globalThis.gc).toBeTypeOf('function');
    const home = await seedWireHome(undefined, true);
    const agents = new FakeAgents();
    const gates = new Map<string, { promise: Promise<void>; release(): void }>();
    const gate = () => {
      let release!: () => void;
      return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    };
    const ids = ['main', 'child-a', 'child-b'];
    for (const id of ids) gates.set(id, gate());
    const handles = ids.map(id => agents.add(id, { wire: { ...stubAgentWire(), flush: () => gates.get(id)!.promise } }));
    const warn = vi.fn();
    const service = new TranscriptService({ homeDir: home, logger: { warn }, residentLimits: { tailTurns: 0, maxBytes: 1 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      opsJournalLimits: { maxAgentBytes: 64 << 10, maxTotalBytes: 64 << 10 } });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    const collect = async () => {
      spy.mockClear();
      for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc?.(); }
    };
    const body = (agent: string, turn: number, kind: 'prompt' | 'output') => `${agent}:${turn}:${kind}:` + (kind === 'prompt' ? 'p' : 'o').repeat((256 << 10) - `${agent}:${turn}:${kind}:`.length);
    const appendTurn = async (agent: string, turn: number) => {
      const records = [
        { type: 'turn.prompt', turnId: turn, promptId: `p${turn}`, input: [{ type: 'text', text: body(agent, turn, 'prompt') }], origin: { kind: 'user' }, time: turn * 2000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: turn, step: 1, uuid: `s${turn}` } },
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: turn, stepUuid: `s${turn}`, uuid: `f${turn}`, toolCallId: `c${turn}`, name: 'Read', args: {} } },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${turn}`, result: { output: body(agent, turn, 'output'), isError: false } } },
        { type: 'turn.ended', turnId: turn, reason: 'completed', time: turn * 2000 + 1000 },
      ];
      await appendFixtureFile(join(home, 'sessions/ws/s1/agents', agent, 'wire.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) handles[ids.indexOf(agent)]!.bus.emit(ev(record));
    };
    const samples: { round: number; loadedHeap: number; postGcHeap: number; loadedRss: number; postGcRss: number; residentBytes: number; collected: number; replayBytes: number; proofPages: number }[] = [];
    const weak: WeakRef<object>[] = [];
    let secondEntered = false;
    let releaseSecond!: () => void;
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    const initialize = HistoryResidentProof.prototype.initialize;
    const spy = vi.spyOn(HistoryResidentProof.prototype, 'initialize').mockImplementation(async function (this: HistoryResidentProof, signal) {
      await initialize.call(this, signal);
      if (this.draft.agentId === 'main' && this.resident.turnId === 't2') { secondEntered = true; await second; }
    });
    let midRound: { collected: boolean; heap: number; active: number } | undefined;
    try {
      for (const id of ids.slice(1)) {
        const path = join(home, 'sessions/ws/s1/agents', id, 'wire.jsonl');
        await mkdir(dirname(path), { recursive: true });
        await writeFixtureFile(path, '');
      }
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      for (const id of ids.slice(1)) await service.ensureAgentHistory('s1', id);
      vi.mocked(writeFixtureFile).mockClear();
      vi.mocked(appendFixtureFile).mockClear();
      vi.mocked(fsPromises.readFile).mockClear();
      await collect();
      const baseline = process.memoryUsage();
      for (let round = 1; round <= 4; round++) {
        for (const id of ids) {
          for (let turn = (round - 1) * 4 + 1; turn <= round * 4; turn++) {
            await appendTurn(id, turn);
            weak.push(new WeakRef(store.getAgent(id)!.getTurn(`t${turn}`)!));
            weak.push(new WeakRef(store.getAgent(id)!.getTurn(`t${turn}`)!.steps[0]!.frames[0]!));
          }
        }
        vi.mocked(appendFixtureFile).mockClear();
        await collect();
        const loaded = process.memoryUsage();
        for (const owned of gates.values()) owned.release();
        if (round === 1) {
          await vi.waitFor(() => expect(secondEntered).toBe(true));
          expect(store.getAgent('main')?.getTurn('t1')).toBeUndefined();
          await collect();
          const turnCollected = weak[0]!.deref() === undefined;
          const frameCollected = weak[1]!.deref() === undefined;
          const collected = turnCollected && frameCollected;
          midRound = { collected, heap: process.memoryUsage().heapUsed, active: service.memoryReport().readLane.active };
          console.log('mid-sweep-first-release', { turnCollected, frameCollected, ...midRound });
          expect(collected).toBe(true);
          expect(midRound.active).toBeGreaterThan(0);
          releaseSecond();
        }
        await vi.waitFor(() => expect(ids.every(id => store.getAgent(id)?.getItems().every(item => item.kind !== 'turn'))).toBe(true), { timeout: 15_000 });
        await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
        await collect();
        const released = process.memoryUsage();
        const collected = weak.filter(reference => reference.deref() === undefined).length;
        if (globalThis.gc !== undefined) expect(collected).toBe(weak.length);
        const proof = navigation.canonicalReadReport();
        samples.push({ round, loadedHeap: loaded.heapUsed, postGcHeap: released.heapUsed, loadedRss: loaded.rss, postGcRss: released.rss,
          residentBytes: service.memoryReport().residentBytes, collected, replayBytes: proof.replayBytes, proofPages: proof.proofPages });
        for (const id of ids) gates.set(id, gate());
      }
      if (globalThis.gc !== undefined) {
        const warm = samples.slice(1).map(sample => sample.postGcHeap);
        expect(Math.max(...warm) - Math.min(...warm)).toBeLessThanOrEqual(12 << 20);
      }
      let reread = 0;
      for (const id of ids) for (let turn = 1; turn <= 16; turn++) {
        const entity = await service.readCanonicalEntity('s1', id, { kind: 'turn', id: `t${turn}` }, new AbortController().signal) as TranscriptTurn;
        expect(entity.prompt).toBe(body(id, turn, 'prompt'));
        expect(entity.steps).toHaveLength(1);
        expect(entity.steps[0]?.frames).toHaveLength(1);
        expect(entity.steps[0]?.frames[0]).toMatchObject({ kind: 'tool', toolCallId: `c${turn}`, output: body(id, turn, 'output') });
        reread++;
      }
      const unmatched = [
        { type: 'turn.prompt', turnId: 100, promptId: 'mismatch', input: [{ type: 'text', text: 'disk fact' }], origin: { kind: 'user' }, time: 300_000 },
        { type: 'turn.ended', turnId: 100, reason: 'completed', time: 301_000 },
      ];
      await appendFixtureFile(join(home, 'sessions/ws/s1/agents/main/wire.jsonl'), unmatched.map(record => JSON.stringify(record)).join('\n') + '\n');
      handles[0]!.bus.emit(ev({ ...unmatched[0], input: [{ type: 'text', text: 'live unmatched fact' }] }));
      handles[0]!.bus.emit(ev(unmatched[1]!));
      handles[0]!.bus.emit(ev({ type: 'turn.prompt', turnId: 101, promptId: 'active', input: [{ type: 'text', text: 'active fact' }], origin: { kind: 'user' }, time: 302_000 }));
      for (const owned of gates.values()) owned.release();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ mismatch: 1 }), 'transcript: retaining turns without matching bounded durable proof'));
      expect(store.getAgent('main')?.getTurn('t100')).toMatchObject({ state: 'completed', prompt: 'live unmatched fact' });
      expect(store.getAgent('main')?.getTurn('t101')).toMatchObject({ state: 'running', prompt: 'active fact' });
      expect(reread).toBe(48);
      console.log('multi-agent-resident-plateau', { agents: 3, rounds: 4, turns: 48, payloadBytes: 24 << 20, baseline: { heap: baseline.heapUsed, rss: baseline.rss },
        samples, midRound, weakReferences: weak.length, reread, gc: globalThis.gc !== undefined, eventLoopDelay: service.memoryReport().eventLoopDelay,
        proof: navigation.canonicalReadReport(), maxRss: process.resourceUsage().maxRSS * 1024 });
    } finally { releaseSecond(); spy.mockRestore(); for (const owned of gates.values()) owned.release(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 120_000);

  it('counts long derived private index keys even when resident frame IDs are shared and durable IDs are short', async () => {
    const frameIds = Array.from({ length: 48 }, (_, index) => `${index}:` + 'k'.repeat(100_000));
    const resident: TranscriptTurn = { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed',
      frames: frameIds.map(frameId => ({ kind: 'text', frameId, role: 'assistant', text: 'value' })) }] };
    const proof = new HistoryResidentProof(resident, 'main');
    const signal = new AbortController().signal;
    await proof.initialize(signal);
    expect(await proof.apply({ type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'long frame IDs' }], origin: { kind: 'user' } }, signal)).toBe(true);
    expect(await proof.apply({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } }, signal)).toBe(true);
    let rejectedAt = -1;
    for (const [index, frameId] of frameIds.entries()) {
      const accepted = await proof.apply({ type: 'context.append_loop_event', id: `r${index}`, event: { type: 'content.part', turnId: 1, stepUuid: 's1', uuid: frameId, part: { type: 'text', text: 'value' } } }, signal);
      if (!accepted) { rejectedAt = index; break; }
    }
    expect(rejectedAt).toBeGreaterThanOrEqual(0);
    expect(rejectedAt).toBeLessThan(48);
    expect(proof.extraBytes()).toBeGreaterThan(8 << 20);
    expect(proof.draft.residentIndexBytes()).toBeGreaterThan(1 << 20);
    expect(resident.steps[0]?.frames).toHaveLength(48);
    console.log('derived-private-index-budget', { rejectedAt, draftIndexBytes: proof.draft.residentIndexBytes(), extraBytes: proof.extraBytes(), ...proof.report() });
  }, 20_000);

  it('reuses a sub-8MiB wide numeric record with bounded traversal and cancels inside traversal', async () => {
    const resident: TranscriptTurn = { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [] };
    const record = { type: 'context.append_loop_event', event: { type: 'tool.progress', toolCallId: 'call', update: { kind: 'custom', customData: Array.from({ length: 1_000_000 }, () => 0) } } };
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(8 << 20);
    const original = Object.entries;
    const entries = vi.spyOn(Object, 'entries').mockImplementation(value => {
      if (Array.isArray(value) && value.length > 100_000) throw new Error('wide_entries_materialized');
      return original(value);
    });
    try {
      const proof = new HistoryResidentProof(resident, 'main');
      await proof.initialize(new AbortController().signal);
      const cancelled = new AbortController();
      const active = proof.apply(record, cancelled.signal);
      setImmediate(() => cancelled.abort(new DOMException('Traversal cancelled', 'AbortError')));
      await expect(active).rejects.toMatchObject({ name: 'AbortError' });
      expect(proof.snapshot().items).toEqual([]);
      expect(proof.report().traversalPeakBytes).toBeGreaterThan(0);
      expect(proof.report().traversalPeakBytes).toBeLessThan(4 << 10);
      for (const seed of [
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'wide progress' }], origin: { kind: 'user' } },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } },
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 's1', toolCallId: 'call', name: 'Read', args: {} } },
      ]) expect(await proof.apply(seed, new AbortController().signal)).toBe(true);
      expect(await proof.apply(record, new AbortController().signal)).toBe(false);
      expect(proof.extraBytes()).toBeGreaterThan(8 << 20);
      expect(proof.report().traversalPeakBytes).toBeLessThan(4 << 10);
      expect(record.event.update.customData).toHaveLength(1_000_000);
      console.log('wide-record-proof-traversal', { recordBytes: Buffer.byteLength(JSON.stringify(record)), traversalPeakBytes: proof.report().traversalPeakBytes, extraBytes: proof.extraBytes() });
    } finally { entries.mockRestore(); }
  }, 20_000);

  it('bounds the resident string index before canonical replay without expanding its traversal frontier', async () => {
    const resident: TranscriptTurn = { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', steps: [],
      origin: { kind: 'user', payload: Array.from({ length: 140_000 }, (_, index) => `value-${index}`) } };
    const proof = new HistoryResidentProof(resident, 'main');
    await proof.initialize(new AbortController().signal);
    expect(proof.extraBytes()).toBeGreaterThan(8 << 20);
    expect(proof.snapshot().items).toEqual([]);
    expect((resident.origin.payload as unknown[]).length).toBe(140_000);
  });

  it('rebases replaced frame workspace instead of retaining cumulative record allocation charges', async () => {
    const resident: TranscriptTurn = { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [] };
    const proof = new HistoryResidentProof(resident, 'main');
    const signal = new AbortController().signal;
    await proof.initialize(signal);
    for (const seed of [
      { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'replaced progress' }], origin: { kind: 'user' } },
      { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 's1', toolCallId: 'call', name: 'Read', args: {} } },
    ]) expect(await proof.apply(seed, signal)).toBe(true);
    const update = (index: number) => ({ type: 'context.append_loop_event', id: `progress-${index}`, event: { type: 'tool.progress', toolCallId: 'call', update: { kind: 'status', text: `${index}:` + 'v'.repeat(4096) } } });
    for (let index = 0; index < 2000; index++) expect(await proof.apply(update(index), signal)).toBe(true);
    expect(await proof.reconcileBudget(signal)).toBe(true);
    expect(proof.extraBytes()).toBeLessThan(1 << 20);
    expect(proof.snapshot().items[0]).toMatchObject({ steps: [{ frames: [{ toolCallId: 'call', progress: { text: '1999:' + 'v'.repeat(4096) } }] }] });
    expect(proof.report().reconciliations).toBeLessThan(200);
    console.log('replaced-frame-proof-state', { records: 2003, extraBytes: proof.extraBytes(), ...proof.report() });
  }, 20_000);

  it.each([300, 600])('bounds durable dedup state across pages of %s updates to one frame without forgetting duplicate IDs', async (updates) => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    const agents = new FakeAgents();
    let releaseFlush!: () => void;
    const flush = new Promise<void>(resolve => { releaseFlush = resolve; });
    const main = agents.add('main', { wire: { ...stubAgentWire(), flush: async () => flush } });
    const warn = vi.fn();
    const service = new TranscriptService({ homeDir: home, logger: { warn }, residentLimits: { tailTurns: 0, maxBytes: 1 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      opsJournalLimits: { maxAgentBytes: 64 << 10, maxTotalBytes: 64 << 10 } });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    const update = (index: number, text = `progress-${index}`) => ({ type: 'context.append_loop_event', id: `${index}:` + 'i'.repeat(8192),
      event: { type: 'tool.progress', toolCallId: 'call', update: { kind: 'status', text } } });
    let rejected = false;
    let acceptedAfterReject = 0;
    let callsAfterReject = 0;
    const apply = HistoryResidentProof.prototype.apply;
    const spy = vi.spyOn(HistoryResidentProof.prototype, 'apply').mockImplementation(async function (this: HistoryResidentProof, record, signal) {
      if (rejected) callsAfterReject++;
      const result = await apply.call(this, record, signal);
      if (rejected && result) acceptedAfterReject++;
      if (!result) rejected = true;
      return result;
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const records = [
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'progress history' }], origin: { kind: 'user' }, time: 2000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 'step' } },
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 'step', uuid: 'frame', toolCallId: 'call', name: 'Read', args: {} } },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'call', result: { output: 'done', isError: false } } },
        ...Array.from({ length: updates }, (_, index) => update(index)), update(0, 'duplicate must not replace final progress'),
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 },
      ];
      await appendFixtureFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) main.bus.emit(ev(record));
      expect(store.getAgent('main')?.getTurn('t1')?.steps[0]?.frames).toHaveLength(1);
      expect(store.getAgent('main')?.getTurn('t1')?.steps[0]?.frames[0]).toMatchObject({ progress: { text: `progress-${updates - 1}` } });
      releaseFlush();
      if (updates === 600) {
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ overBudget: 1 }), 'transcript: retaining turns without matching bounded durable proof'));
        expect(store.getAgent('main')?.getTurn('t1')).toMatchObject({ state: 'completed' });
        expect(navigation.canonicalReadReport().proofMaxExtraBytes).toBeGreaterThan(8 << 20);
      } else {
        await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t1')).toBeUndefined());
        expect(navigation.canonicalReadReport().proofMaxExtraBytes).toBeLessThanOrEqual(8 << 20);
      }
      await vi.waitFor(() => expect(service.memoryReport().readLane.active).toBe(0));
      const proof = navigation.canonicalReadReport();
      expect(proof.proofPages).toBeGreaterThan(1);
      expect(proof.proofMaxPageBytes).toBeLessThanOrEqual(8 << 20);
      const reread = await service.readCanonicalEntity('s1', 'main', { kind: 'turn', id: 't1' }, new AbortController().signal) as TranscriptTurn;
      expect(reread.steps[0]?.frames).toHaveLength(1);
      expect(reread.steps[0]?.frames[0]).toMatchObject({ progress: { text: `progress-${updates - 1}` } });
      expect(callsAfterReject).toBe(0);
      expect(acceptedAfterReject).toBe(0);
      if (updates === 600) expect(proof.proofRejectedOrdinal).toBeTypeOf('number');
      console.log('resident-proof-dedup-budget', { updates, pages: proof.proofPages, maxExtraBytes: proof.proofMaxExtraBytes, maxPageBytes: proof.proofMaxPageBytes,
        rejectedOrdinal: proof.proofRejectedOrdinal, callsAfterReject, acceptedAfterReject, reconciliations: proof.proofReconciliations });
    } finally { spy.mockRestore(); releaseFlush(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 20_000);

  it('skips unchanged failed proofs after unrelated appends and retries changed source or resident versions', async () => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: stubAgentWire() });
    const warn = vi.fn();
    const service = new TranscriptService({ homeDir: home, logger: { warn }, residentLimits: { tailTurns: 0, maxBytes: 1 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    const records = (id: number, text: string) => [
      { type: 'turn.prompt', turnId: id, promptId: `p${id}`, input: [{ type: 'text', text }], origin: { kind: 'user' }, time: id * 2000 },
      { type: 'turn.ended', turnId: id, reason: 'completed', time: id * 2000 + 1000 },
    ];
    const emit = (rows: Record<string, unknown>[]) => { for (const record of rows) main.bus.emit(ev(record)); };
    const persist = (rows: Record<string, unknown>[]) => appendFixtureFile(path, rows.map(record => JSON.stringify(record)).join('\n') + '\n');
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      await persist(records(1, 'disk'));
      emit(records(1, 'live'));
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ mismatch: 1 }), 'transcript: retaining turns without matching bounded durable proof'));
      const failed = store.getAgent('main')!.getTurn('t1');
      const before = navigation.canonicalReadReport();
      await persist(records(2, 'unrelated'));
      emit(records(2, 'unrelated'));
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t2')).toBeUndefined());
      expect(store.getAgent('main')?.getTurn('t1')).toBe(failed);
      expect(navigation.canonicalReadReport().proofSkipped).toBeGreaterThan(before.proofSkipped);
      expect(navigation.canonicalReadReport().replays - before.replays).toBe(1);
      await writeFixtureFile(path, [...records(1, 'live'), ...records(2, 'unrelated')].map(record => JSON.stringify(record)).join('\n') + '\n');
      await persist(records(3, 'trigger source refresh'));
      emit(records(3, 'trigger source refresh'));
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t1')).toBeUndefined());
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t3')).toBeUndefined());
      await persist(records(4, 'persisted final'));
      emit(records(4, 'changed live'));
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t4')).toMatchObject({ state: 'completed', prompt: 'changed live' }));
      await vi.waitFor(() => expect(service.memoryReport().readLane.active).toBe(0));
      const failedAgain = navigation.canonicalReadReport().replays;
      const transcript = store.getAgent('main')!;
      transcript.apply([{ op: 'turn.upsert', turn: { ...transcript.getTurn('t4')!, prompt: 'persisted final' } }]);
      await persist(records(5, 'trigger resident refresh'));
      emit(records(5, 'trigger resident refresh'));
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t4')).toBeUndefined());
      expect(navigation.canonicalReadReport().replays).toBeGreaterThan(failedAgain);
    } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 20_000);

  it.each(['abort', 'rewrite', 'resident', 'close'] as const)('keeps facts when resident proof encounters %s before publication', async (phase) => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    const agents = new FakeAgents();
    let releaseFlush!: () => void;
    const flush = new Promise<void>(resolve => { releaseFlush = resolve; });
    const main = agents.add('main', { wire: { ...stubAgentWire(), flush: async () => flush } });
    const warn = vi.fn();
    const service = new TranscriptService({ homeDir: home, logger: { warn }, residentLimits: { tailTurns: 0, maxBytes: 1 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    let entered = false;
    const abort = new AbortController();
    const initialize = HistoryResidentProof.prototype.initialize;
    const spy = vi.spyOn(HistoryResidentProof.prototype, 'initialize').mockImplementationOnce(async function (this: HistoryResidentProof, signal) {
      await initialize.call(this, signal);
      entered = true;
      if (phase === 'abort') abort.abort(new DOMException('Proof cancelled', 'AbortError'));
      else if (phase === 'close') service.dropSession('s1');
      else if (phase === 'rewrite') await writeFixtureFile(path, (await fsPromises.readFile(path, 'utf8')).replace('canonical prompt', 'different prompt'));
      else {
        const transcript = service.forSessionLive('s1')!.getAgent('main')!;
        const resident = transcript.getTurn('t1')!;
        transcript.apply([{ op: 'turn.upsert', turn: { ...resident, prompt: 'new live fact' } }]);
      }
    });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const records = [
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'canonical prompt' }], origin: { kind: 'user' }, time: 2000 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 },
      ];
      await appendFixtureFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) main.bus.emit(ev(record));
      if (phase === 'abort') {
        let source;
        do { source = await navigation.prepareResidentProof('s1', 'main', abort.signal); } while (source === undefined);
        await expect(source.prove(store.getAgent('main')!.getTurn('t1')!, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
      } else releaseFlush();
      await vi.waitFor(() => expect(entered).toBe(true));
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
      expect(store.getAgent('main')?.getTurn('t1')).toMatchObject({ prompt: phase === 'resident' ? 'new live fact' : 'canonical prompt', state: 'completed' });
      if (phase === 'close') expect(service.memoryReport().liveSessions).toBe(0);
      if (phase === 'rewrite') expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'transcript: durability clearance failed; keeping resident history');
    } finally { spy.mockRestore(); releaseFlush(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('proves and releases all 288 frames across bounded pages and rereads the complete turn', async () => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
    let releaseFlush!: () => void;
    const flushing = new Promise<void>(resolve => { releaseFlush = resolve; });
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(), flush: async () => flushing,
      verifyTranscriptLiveEpoch: async () => false, isTranscriptLiveEpochVerified: () => false } });
    const warn = vi.fn();
    const service = new TranscriptService({ homeDir: home, logger: { warn },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents),
      residentLimits: { tailTurns: 0, maxBytes: 1 << 20 }, opsJournalLimits: { maxAgentBytes: 64 << 10, maxTotalBytes: 64 << 10 } });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      const append = async (records: Record<string, unknown>[]) => {
        await appendFixtureFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
        for (const record of records) main.bus.emit(ev(record));
      };
      await append([
        { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'read all parts' }], origin: { kind: 'user' }, time: 3_000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } },
      ]);
      const output = (index: number) => `${index}:` + 'x'.repeat(32 << 10);
      for (let index = 0; index < 288; index++) await append([
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 's1', uuid: `f${index}`, toolCallId: `c${index}`, name: 'Read', args: {} } },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${index}`, result: { output: output(index), isError: false } } },
      ]);
      await append([{ type: 'turn.ended', turnId: 1, reason: 'completed', time: 4_000 }]);
      expect((await fsPromises.stat(path)).size).toBeGreaterThan(8 << 20);
      const before = navigation.canonicalReadReport();
      const oldTurn = new WeakRef(store.getAgent('main')!.getTurn('t1')!);
      const oldFrame = new WeakRef(store.getAgent('main')!.getTurn('t1')!.steps[0]!.frames[0]!);
      globalThis.gc?.();
      const loadedHeap = process.memoryUsage().heapUsed;
      releaseFlush();
      await vi.waitFor(() => expect(store.getAgent('main')?.getTurn('t1')).toBeUndefined(), { timeout: 15_000 });
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
      const proof = navigation.canonicalReadReport();
      expect(proof.proofPages).toBeGreaterThan(1);
      expect(proof.proofMaxPageBytes).toBeLessThanOrEqual(8 << 20);
      expect(proof.proofMaxExtraBytes).toBeLessThanOrEqual(8 << 20);
      expect(proof.replayBytes - before.replayBytes).toBeGreaterThan(8 << 20);
      expect(proof.replayRecords - before.replayRecords).toBeGreaterThan(288);
      expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ overBudget: 1 }), 'transcript: retaining turns without matching bounded durable proof');
      if (globalThis.gc !== undefined) {
        for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
        expect(oldTurn.deref()).toBeUndefined();
        expect(oldFrame.deref()).toBeUndefined();
      }
      const releasedHeap = process.memoryUsage().heapUsed;
      const beforePublic = navigation.canonicalReadReport();
      const reread = await service.readCanonicalEntity('s1', 'main', { kind: 'turn', id: 't1' }, new AbortController().signal) as TranscriptTurn;
      const frames = reread.steps.flatMap(step => step.frames);
      expect(frames).toHaveLength(288);
      for (const [index, frame] of frames.entries()) expect(frame).toMatchObject({ kind: 'tool', toolCallId: `c${index}`, output: output(index) });
      expect(navigation.canonicalReadReport().replayBytes - beforePublic.replayBytes).toBeGreaterThan(8 << 20);
      console.log('cumulative-proof-budget', { proofBytes: proof.replayBytes - before.replayBytes,
        proofRecords: proof.replayRecords - before.replayRecords, publicFrames: frames.length,
        pages: proof.proofPages, maxPageBytes: proof.proofMaxPageBytes, maxExtraBytes: proof.proofMaxExtraBytes,
        loadedHeap, releasedHeap, eventLoopDelay: service.memoryReport().eventLoopDelay,
        maxRss: process.resourceUsage().maxRSS * 1024 });
    } finally { releaseFlush(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 40_000);

  it.each(['flush', 'proof'] as const)('cancels residency maintenance at %s and releases the closed main store', async (phase) => {
    const home = await seedWireHome(undefined, true);
    const agents = new FakeAgents();
    let started = false;
    let finishFlush!: () => void;
    const flushGate = new Promise<void>(resolve => { finishFlush = resolve; });
    const main = agents.add('main', { wire: { ...stubAgentWire(), flush: async () => {
      if (phase === 'flush') { started = true; await flushGate; }
    } } });
    const service = new TranscriptService({ homeDir: home, residentLimits: { tailTurns: 0, maxBytes: 1 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    let proofSignal: AbortSignal | undefined;
    if (phase === 'proof') vi.spyOn(navigation, 'scan').mockImplementation(async (_session, _agent, signal) => {
      proofSignal = signal;
      started = true;
      await new Promise<void>((_resolve, reject) => {
        signal!.throwIfAborted();
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return undefined;
    });
    let store: TranscriptStore | undefined;
    try {
      store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      main.bus.emit(ev({ type: 'turn.prompt', turnId: 1, promptId: 'pending', input: [{ type: 'text', text: 'pending persistence' }], origin: { kind: 'user' }, time: 3000 }));
      main.bus.emit(ev({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 4000 }));
      await vi.waitFor(() => expect(started).toBe(true));
      const resident = new WeakRef(store);
      service.dropSession('s1'); store = undefined;
      await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 }));
      if (phase === 'proof') expect(proofSignal?.aborted).toBe(true);
      if (globalThis.gc !== undefined) {
        for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
        expect(resident.deref()).toBeUndefined();
      }
      expect(service.memoryReport()).toMatchObject({ liveSessions: 0, residentBytes: 0 });
      console.log('cancelled-residency-release', { phase, heapAfterDrop: process.memoryUsage().heapUsed, maxRss: process.resourceUsage().maxRSS * 1024 });
    } finally { finishFlush(); service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('does not repeatedly replay an unverified wire for background residency maintenance', async () => {
    const home = await seedWireHome(undefined, true);
    const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await writeFixtureFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({ format: 1, epoch: 'legacy-open', state: 'open', trusted: false }));
    const verify = vi.fn(async () => false);
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(), verifyTranscriptLiveEpoch: verify, isTranscriptLiveEpochVerified: () => false } });
    const reader = vi.fn(streamWireRecords);
    const service = new TranscriptService({ homeDir: home, wireRecordReader: reader, residentLimits: { tailTurns: 1, maxBytes: 1024 },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      expect(reader).toHaveBeenCalledTimes(1);
      const records = [1, 2].flatMap((turnId) => [
        { type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: 'read' }], origin: { kind: 'user' }, time: turnId * 2000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: `s${turnId}` } },
        { type: 'context.append_loop_event', event: { type: 'tool.call', turnId, stepUuid: `s${turnId}`, uuid: `f${turnId}`, toolCallId: `c${turnId}`, name: 'Read', args: {} } },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${turnId}`, result: { output: 'x'.repeat(8192), isError: false } } },
        { type: 'turn.ended', turnId, reason: 'completed', time: turnId * 2000 + 1000 },
      ]);
      await appendFixtureFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) main.bus.emit(ev(record));
      await vi.waitFor(() => expect(verify.mock.calls.length).toBeGreaterThan(1));
      expect(reader).toHaveBeenCalledTimes(1);
      expect(store.getAgent('main')?.getTurn('t1')).toBeDefined();
      expect(store.getAgent('main')?.snapshot().toolCallCountKnown).toBe(false);
    } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('serves a bounded first-screen tail while full main replay and wire verification remain pending', async () => {
    const home = await seedWireHome();
    const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await appendFile(path, Array.from({ length: 48 }, (_, turnId) => JSON.stringify({
      type: 'turn.prompt', turnId: turnId + 1, promptId: `p-${turnId + 1}`,
      input: [{ type: 'text', text: `question ${turnId + 1} ${'x'.repeat(48_000)}` }], origin: { kind: 'user' }, time: 10_000 + turnId,
    })).join('\n') + '\n');
    await writeFixtureFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({ format: 1, epoch: 'legacy-open', state: 'open', trusted: false }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verify = vi.fn(async () => { await gate; return false; });
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(), verifyTranscriptLiveEpoch: verify, isTranscriptLiveEpochVerified: () => false } });
    const reads: { start?: number; end?: number }[] = [];
    const service = new TranscriptService({ homeDir: home,
      wireRecordReader: async (wirePath, options) => {
        reads.push({ start: options.startByteOffset, end: options.endByteOffset });
        return streamWireRecords(wirePath, options);
      },
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      service.forSessionLive('s1');
      await vi.waitFor(() => expect(verify).toHaveBeenCalled());
      let page: Awaited<ReturnType<typeof service.ensureAgentHistory>>;
      const pending = service.ensureAgentHistory('s1', 'main', { tailFirst: true }).then((value) => { page = value; });
      await vi.waitFor(() => expect(page).toBeDefined(), { timeout: 500 });
      expect(page!.getItems().at(-1)).toMatchObject({ kind: 'turn', turnId: 't48' });
      expect(page!.snapshot()).toMatchObject({ toolCallCountKnown: false, hasMoreOlder: true });
      expect(reads.every((read) => read.end !== undefined && (read.start ?? 0) > 0)).toBe(true);
      const cursor = service.getTranscriptCursor('s1', 'main');
      expect(cursor).toMatchObject({ seq: expect.any(Number) });
      await pending;
      main.bus.emit(ev({ type: 'turn.started', turnId: 49, origin: { kind: 'user' }, prompt: 'main live while its old proof waits' }));
      expect(page?.getTurn('t49')).toMatchObject({ prompt: 'main live while its old proof waits' });
      expect(service.getTranscriptCursor('s1', 'main')).toMatchObject({ seq: cursor.seq + 1, epoch: cursor.epoch });
      await expect(service.ensureAgentHistory('s1', 'main', { tailFirst: true })).resolves.toBe(page);
      const childPath = join(dirname(dirname(path)), 'child', 'wire.jsonl');
      await mkdir(dirname(childPath), { recursive: true });
      await writeFixtureFile(childPath, await fsPromises.readFile(path));
      const child = agents.add('child', { wire: { ...stubAgentWire(), verifyTranscriptLiveEpoch: verify, isTranscriptLiveEpochVerified: () => false } });
      const childPage = await readSessionViewTranscriptPage(service, 's1', { agentId: 'child' });
      expect(childPage).toMatchObject({ agent_id: 'child' });
      expect(childPage?.items.at(-1)).toMatchObject({ turnId: 't48' });
      expect(childPage?.coverage).toMatchObject({ kind: 'unknown' });
      expect(verify.mock.calls.length).toBeGreaterThan(1);
      child.bus.emit(ev({ type: 'turn.started', turnId: 49, origin: { kind: 'user' }, prompt: 'child live while main proof waits' }));
      expect(service.forSessionLive('s1')?.getAgent('child')?.getTurn('t49')).toMatchObject({ prompt: 'child live while main proof waits' });
      const controller = new AbortController(); controller.abort();
      await expect(service.ensureAgentHistory('s1', 'main', { tailFirst: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      release();
      await service.whenReady('s1');
      expect(page?.getTurn('t49')).toMatchObject({ prompt: 'main live while its old proof waits' });
      const full = await service.ensureAgentHistory('s1', 'main', { fullHistory: true });
      expect(full?.getTurn('t0')).toBeDefined();
      expect(full?.getTurn('t49')).toMatchObject({ prompt: 'main live while its old proof waits' });
    } finally {
      release();
      await service.whenReady('s1');
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('finishes tail-first live replay before verification and retains the explicit full-history contract', async () => {
    const home = await seedWireHomeWithTool();
    const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await appendFile(path, Array.from({ length: 48 }, (_, turnId) => JSON.stringify({
      type: 'turn.prompt', turnId: turnId + 1, promptId: `p-${turnId + 1}`,
      input: [{ type: 'text', text: `question ${turnId + 1} ${'x'.repeat(48_000)}` }], origin: { kind: 'user' }, time: 10_000 + turnId,
    })).join('\n') + '\n');
    await writeFixtureFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({ format: 1, epoch: 'legacy-open', state: 'open', trusted: false }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verify = vi.fn(async () => { await gate; return false; });
    const agents = new FakeAgents();
    const main = agents.add('main', { wire: { ...stubAgentWire(), verifyTranscriptLiveEpoch: verify, isTranscriptLiveEpochVerified: () => false } });
    const service = new TranscriptService({ homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const store = service.forSessionLive('s1', { tailFirst: true })!;
      const visible = await service.ensureAgentHistory('s1', 'main', { tailFirst: true });
      expect(verify).not.toHaveBeenCalled();
      expect(visible?.getItems().at(-1)).toMatchObject({ turnId: 't48' });
      expect(visible?.snapshot().toolCallCountKnown).toBe(false);
      const cursor = service.getTranscriptCursor('s1', 'main');
      const events: { ops: readonly TranscriptOperation[]; seq: number }[] = [];
      service.onSessionOps('s1', (event, position) => { events.push({ ops: event.ops, seq: position.seq }); });
      main.bus.emit(ev({ type: 'turn.started', turnId: 49, origin: { kind: 'user' }, prompt: 'live after first screen' }));
      expect(store.getAgent('main')?.getTurn('t49')).toMatchObject({ prompt: 'live after first screen' });
      expect(events[0]?.seq).toBe(cursor.seq + 1);
      let full: AgentTranscript | undefined;
      const pending = service.ensureAgentHistory('s1', 'main', { fullHistory: true }).then((value) => { full = value; });
      await vi.waitFor(() => expect(verify).toHaveBeenCalled());
      expect(full).toBeUndefined();
      release();
      await pending;
      expect(full?.getTurn('t0')).toBeDefined();
      expect(full?.getTurn('t48')).toBeDefined();
      expect(full?.getTurn('t49')).toMatchObject({ prompt: 'live after first screen' });
      expect(new Set(full?.getItems().map((item) => item.kind === 'turn' ? item.turnId : item.kind)).size).toBe(full?.getItems().length);
    } finally {
      release();
      await service.whenReady('s1');
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('keeps an established unverified main projection after ordinary appends without repeating its full backfill', async () => {
    const home = await seedWireHome();
    const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await writeFixtureFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({ format: 1, epoch: 'legacy-open', state: 'open', trusted: false }));
    const agents = new FakeAgents();
    agents.add('main', { wire: { ...stubAgentWire(), verifyTranscriptLiveEpoch: async () => false, isTranscriptLiveEpochVerified: () => false } });
    const reader = vi.fn(streamWireRecords);
    const service = new TranscriptService({ homeDir: home, wireRecordReader: reader,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const store = service.forSessionLive('s1')!;
      await service.whenReady('s1');
      expect(reader).toHaveBeenCalledTimes(1);
      expect(store.getAgent('main')?.snapshot()).toMatchObject({ toolCallCountKnown: false });
      await appendFixtureFile(path, JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 }) + '\n');
      await service.ensureAgentHistory('s1', 'main');
      expect(reader).toHaveBeenCalledTimes(1);
      expect(store.getAgent('main')?.snapshot()).toMatchObject({ toolCallCountKnown: false });
      expect(await service.verifyTranscriptLiveCoverage('s1', 'main')).toBe(false);
    } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
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
      await wire.sealTranscriptEpoch!();
      const sealed = parseWireTranscriptReceipt(JSON.parse(
        (await fsPromises.readFile(join(dirname(path), WIRE_TRANSCRIPT_RECEIPT_KEY), 'utf8')),
      ));
      expect(sealed).toMatchObject({ state: 'sealed', trusted: false });
      agents.remove('child-tamper');
      expect(await service.readColdSnapshot('s1', 'child-tamper')).toMatchObject({
        toolCallCountKnown: false, hasMoreOlder: true,
      });
    } finally {
      await ix.dispose();
      await log.dispose();
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
      await ix.dispose();
      await wireLog.dispose();
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
      await ix.dispose();
      await wireLog.dispose();
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
        if (scenario.name === 'corrupt') {
          await expect(service.readColdSnapshot('s1', 'main')).rejects.toThrow('corrupted line');
          expect((await service.getAgentToolCallCounts('s1', ['main'])).has('main')).toBe(false);
          service.dispose();
          continue;
        }
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

  it.each(['EACCES', 'EIO', 'ENOENT'])('preserves %s errors when an existing cold wire cannot be read', async (code) => {
    const home = await seedWireHomeWithTool();
    const failure = Object.assign(new Error(`synthetic wire read ${code}`), { code });
    const service = new TranscriptService({
      homeDir: home,
      core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
      wireRecordReader: async () => { throw failure; },
    });
    try {
      await expect(service.readColdSnapshot('s1', 'main')).rejects.toBe(failure);
      await expect(service.readColdPageSnapshot('s1', 'main', (snapshot) => snapshot)).rejects.toBe(failure);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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

  it('hands backfill replay state to live clear and pages without resurrecting removed conversation entities', async () => {
    const home = await seedWireHomeWithTool(false);
    const agents = new FakeAgents();
    const main = agents.add('main');
    const service = new TranscriptService({ homeDir: home, core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), agents) });
    try {
      const originalRead = service.readColdSnapshot.bind(service);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(service, 'readColdSnapshot').mockImplementation(async (...args) => { await gate; return originalRead(...args); });
      const store = service.forSessionLive('s1')!;
      const path = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const records = [
        { type: 'context.clear', time: 6_000 },
        { type: 'turn.prompt', turnId: 1, promptId: 'new', input: [{ type: 'text', text: 'new' }], origin: { kind: 'user' }, time: 6_000 },
      ];
      for (const record of records) {
        await appendFile(path, `${JSON.stringify(record)}\n`);
        main.bus.emit(ev(record));
      }
      release();
      await service.whenReady('s1');
      const transcript = store.getAgent('main')!;
      expect(transcript.getItems().filter((item) => item.kind === 'turn').map((turn) => turn.turnId)).toEqual(['t1']);
      const delivery = { type: 'context.append_message', message: { id: 'followup', role: 'user', content: [{ type: 'text', text: 'followup' }], origin: { kind: 'user' } }, delivery: { deliveryId: 'followup-delivery', messageId: 'followup', origin: 'user' }, time: 6_001 };
      await appendFile(path, `${JSON.stringify(delivery)}\n`);
      main.bus.emit(ev(delivery));
      expect(transcript.getTurn('t1')?.steps.flatMap((step) => step.frames).map((frame) => frame.frameId)).toContain('followup');
      const clear = { type: 'context.clear', time: 7_000 };
      await appendFile(path, `${JSON.stringify(clear)}\n`);
      main.bus.emit(ev(clear));
      expect(transcript.getItems().some((item) => item.kind === 'turn' || (item.kind === 'marker' && item.marker === 'message.delivery'))).toBe(false);
      const paged = await service.readFullAgentSnapshot('s1', 'main', transcript);
      expect(paged?.items.some((item) => item.kind === 'turn' || (item.kind === 'marker' && item.marker === 'message.delivery'))).toBe(false);
    } finally {
      service.dispose();
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
          const unchanged = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't26' });
          expect(unchanged?.items.filter((item) => item.kind === 'turn')).toHaveLength(20);
          expect(scans).toHaveLength(3);
        } finally { clock.mockRestore(); }
      } finally {
        service.dispose();
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('reuses lightweight consecutive cold pages without caching the oversized canonical body', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const large = 'x'.repeat(50_000);
      await appendFile(wirePath, `${Array.from({ length: 190 }, (_, index) => JSON.stringify({
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
      const navigationDb = HistoryNavigationDb.lazy(join(home, 'server', 'history-navigation.sqlite'));
      const navigation = new HistoryLocatorStore(navigationDb, service);
      service.setHistoryLocatorReader(() => navigation);
      try {
        const size = (await fsPromises.stat(wirePath)).size;
        const first = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
        const second = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't171' });
        expect(size).toBeGreaterThan(8 << 20);
        expect(first?.items.length).toBeGreaterThan(0);
        expect(second?.items.length).toBeGreaterThan(0);
        expect(jsonBytes(first)).toBeLessThanOrEqual(1 << 20);
        expect(jsonBytes(second)).toBeLessThanOrEqual(1 << 20);
        expect(first?.items.map((item) => item.kind === 'turn' ? item.ordinal : -1)).toEqual(Array.from({ length: first!.items.length }, (_, index) => 191 - first!.items.length + index));
        expect(second?.items.map((item) => item.kind === 'turn' ? item.ordinal : -1)).toEqual(Array.from({ length: second!.items.length }, (_, index) => 171 - second!.items.length + index));
        expect(first?.coverage.kind).toBe('unknown');
        expect(second?.coverage.kind).toBe('unknown');
        const third = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't151' });
        expect(third?.items.map((item) => item.kind === 'turn' ? item.ordinal : -1)).toEqual(Array.from({ length: third!.items.length }, (_, index) => 151 - third!.items.length + index));
        expect(scans).toBe(3);
        expect(service.memoryReport().coldReads.bytes).toBeLessThan(size);
        const tail = first!.items.at(-1)!;
        if (tail.kind !== 'turn') throw new Error('Expected the latest turn');
        let original = tail;
        while (original.contentRefs?.length) {
          const segment = await readSessionViewTranscriptContent(service, 's1', { agentId: 'main', ref: original.contentRefs[0]! });
          expect(segment).toBeDefined();
          original = applyContentSegment(original, segment!);
        }
        expect(original).toMatchObject({ kind: 'turn', turnId: 't190', prompt: large });
        expect(scans).toBe(3);
        expect(navigation.canonicalReadReport()).toMatchObject({ replays: 0, replayRecords: 0 });
        expect(navigation.canonicalReadReport().replayBytes).toBeLessThan(51_000);
      } finally {
        service.dispose();
        await navigationDb.close();
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
        expect(draftCheckpoint).toHaveBeenCalledTimes(1);
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
        expect(draftCheckpoint).toHaveBeenCalledTimes(1);
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

    it('rebuilds a format 7 EOF checkpoint to recover answered question time from unchanged wire', async () => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      const response = { answers: { q_0: { kind: 'other', text: 'Read the complete appendix before proceeding.' } } };
      await appendFile(wirePath, `${[
        { type: 'turn.ended', turnId: 0, reason: 'completed', time: 5_500 },
        { type: 'interaction.request', id: 'question-upgrade', kind: 'question',
          request: { questions: [{ question: 'Choose a reference', options: [{ label: 'Appendix' }] }] },
          origin: { agentId: 'main' }, time: 6_000 },
        { type: 'interaction.resolved', id: 'question-upgrade', response, time: 7_000 },
        { type: 'turn.prompt', turnId: 1, origin: { kind: 'user' },
          input: [{ type: 'text', text: 'Continue after the answer.' }], time: 8_000 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 9_000 },
        ...Array.from({ length: 300 }, (_, index) => ({ type: 'executor.runtime.update', kind: 'stable', index })),
      ].map((record) => JSON.stringify(record)).join('\n')}\n`);
      const originalWire = await fsPromises.readFile(wirePath);
      const receiptPath = join(dirname(wirePath), WIRE_TRANSCRIPT_RECEIPT_KEY);
      const originalReceipt = await fsPromises.readFile(receiptPath);
      const core = fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents());
      const query = core.accessor.get(IQueryStore);
      const key = 'ws\0s1\0main';
      const starts: (number | undefined)[] = [];
      const read = async () => {
        const service = new TranscriptService({
          homeDir: home, core,
          wireRecordReader: async (path, options) => {
            starts.push(options.startByteOffset);
            return streamWireRecords(path, options);
          },
        });
        try { return await service.readColdSnapshot('s1', 'main'); }
        finally { service.dispose(); }
      };
      try {
        const expected = await read();
        const checkpoint = await query.get<{
          format: number; nextByteOffset: number; recordCount: number;
          snapshot: AgentTranscriptSnapshot; adapter: TranscriptWireAdapterCheckpoint;
        }>('__transcript_projection_checkpoint__', key);
        expect(checkpoint).toBeDefined();
        expect(checkpoint!.nextByteOffset).toBe(originalWire.byteLength);
        expect(checkpoint!.recordCount).toBeGreaterThanOrEqual(256);
        expect(originalWire.byteLength).toBeLessThanOrEqual(8 << 20);
        const legacy = structuredClone(checkpoint!);
        legacy.format = 7;
        for (const interaction of [...legacy.snapshot.interactions, ...legacy.adapter.interactions.map(([, value]) => value)]) {
          if (interaction.interactionId === 'question-upgrade') {
            delete (interaction.request as Record<string, unknown>)['created_at'];
          }
        }
        expect(legacy.snapshot.interactions).toContainEqual(expect.objectContaining({
          interactionId: 'question-upgrade', state: 'answered', response,
          request: { question_id: 'question-upgrade', questions: [{ id: 'q_0', question: 'Choose a reference',
            options: [{ id: 'opt_0_0', label: 'Appendix' }] }] },
        }));
        await query.put('__transcript_projection_checkpoint__', key, legacy);
        const recovered = await read();
        expect(recovered?.interactions).toContainEqual(expect.objectContaining({
          interactionId: 'question-upgrade', state: 'answered', response,
          request: expect.objectContaining({ created_at: new Date(6_000).toISOString() }),
        }));
        expect(recovered).toEqual(expected);
        expect(starts).toEqual([undefined, undefined]);
        expect((await query.get<{ format: number }>('__transcript_projection_checkpoint__', key))?.format).toBe(13);
        expect(await read()).toEqual(expected);
        expect(starts).toEqual([undefined, undefined, originalWire.byteLength]);
        expect(await fsPromises.readFile(wirePath)).toEqual(originalWire);
        expect(await fsPromises.readFile(receiptPath)).toEqual(originalReceipt);
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('rebuilds projection checkpoint format %s to recover current wire facts', async (format) => {
      const home = await seedWireHomeWithTool();
      const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
      await appendFile(wirePath, `${[
        { type: 'turn.prompt', turnId: 1, origin: { kind: 'user' }, input: [{ type: 'text', text: 'typed generated', presentation: { spans: [{ start: 5, end: 15, kind: 'context' }] } }], time: 10_000 },
        { type: 'turn.step.retrying', turnId: 1, step: 1, failedAttempt: 2, nextAttempt: 3,
          maxAttempts: 5, delayMs: 100, errorName: 'APIConnectionError', errorMessage: 'Connection closed', time: 11_000 },
        { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: 12_000 },
        { type: 'profile.bind', modelAlias: 'example/old', thinkingEffort: 'high', time: 13_000 },
        { type: 'config.update', modelAlias: 'example/new', thinkingEffort: 'low', time: 14_000 },
        { type: 'full_compaction.begin', source: 'auto', time: 15_000 },
        { type: 'context.apply_compaction', summary: 'committed summary', time: 16_000 },
        { type: 'full_compaction.complete', time: 16_001 },
        { type: 'full_compaction.begin', source: 'manual', queued: true, time: 17_000 },
        { type: 'full_compaction.cancel', queued: true, time: 18_000 },
        { type: 'prompt.enqueued', promptId: 'scheduled-example', userMessageId: 'scheduled-example',
          message: { origin: { kind: 'cron_job', jobId: 'job-example' }, content: [{ type: 'text', text: 'Scheduled message body' }] },
          createdAt: new Date(19_000).toISOString(), queueIndex: 0, time: 19_000 },
        { type: 'goal.create', goalId: 'example-goal', objective: 'Verify results', time: 20_000 },
        { type: 'goal.update', tokensUsed: 100, turnsUsed: 1, wallClockMs: 50, time: 20_001 },
        { type: 'goal.update', tokensUsed: 200, time: 20_002 },
        { type: 'goal.update', status: 'paused', reason: 'User paused', actor: 'user', time: 21_000 },
        { type: 'goal.update', status: 'active', time: 22_000 },
        { type: 'executor.runtime.update', kind: 'usage', value: { used: 109786, size: 200000 }, time: 23_000 },
        { type: 'subagent.spawned', subagentId: 'external-child', subagentName: 'worker', parentToolCallId: 'call', runInBackground: true, model: 'vendor-model', thinkingEffort: 'high', thinkingEffortExplicit: true, executorId: 'example-acp', executorProtocol: 'acp-v1', time: 24_000 },
        { type: 'prompt.enqueued', promptId: 'original-request', userMessageId: 'logical-message', message: { id: 'logical-message', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'original text' }] }, time: 24_100 },
        { type: 'turn.prompt', turnId: 3, promptId: 'original-request', managed: true, origin: { kind: 'user' }, input: [{ type: 'text', text: 'original text' }], time: 24_200 },
        { type: 'context.append_message', message: { id: 'logical-message', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'original text' }] }, delivery: { messageId: 'logical-message', turnId: 3, origin: 'user' }, time: 24_300 },
        { type: 'turn.ended', turnId: 3, reason: 'completed', time: 24_400 },
        { type: 'context.undo', count: 1, time: 25_000, replacementPrompt: { promptId: 'edited-request', userMessageId: 'logical-message', alreadyMaterialized: true,
          message: { id: 'logical-message', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'accepted edited text' }] } } },
        { type: 'turn.prompt', turnId: 4, promptId: 'edited-request', managed: true, origin: { kind: 'user' }, input: [{ type: 'text', text: 'accepted edited text' }], time: 25_100 },
        { type: 'turn.ended', turnId: 4, reason: 'completed', time: 25_200 },
        { type: 'turn.prompt', turnId: 5, promptId: 'boundary-prompt', input: [{ type: 'text', text: 'boundary' }], origin: { kind: 'user' }, time: 26_000 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 5, step: 1, uuid: 'step-5a' }, time: 26_100 },
        { type: 'context.append_loop_event', event: { type: 'content.part', turnId: 5, stepUuid: 'step-5a', uuid: 'before-boundary', part: { type: 'text', text: 'before' } }, time: 26_200 },
        { type: 'context.append_loop_event', event: { type: 'step.end', turnId: 5, step: 1, uuid: 'step-5a', finishReason: 'stop' }, time: 26_300 },
        { type: 'context.append_message', time: 26_400, delivery: { deliveryId: 'd-steer-boundary', messageId: 'steer-boundary', turnId: 5, stepId: 'step-5b', step: 2, origin: 'user', deliveredAt: new Date(26_400).toISOString() }, message: { id: 'steer-boundary', role: 'user', content: [{ type: 'text', text: 'anchored user' }], origin: { kind: 'user' } } },
        { type: 'context.append_message', time: 26_500, delivery: { deliveryId: 'd-steer-cue', messageId: 'steer-cue', origin: 'injection', deliveredAt: new Date(26_500).toISOString() }, message: { id: 'steer-cue', role: 'user', content: [{ type: 'text', text: 'CLASSIFY THEN ACT' }], origin: { kind: 'injection', variant: 'model_steering' } } },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 5, step: 2, uuid: 'step-5b' }, time: 26_600 },
        { type: 'context.append_loop_event', event: { type: 'content.part', turnId: 5, stepUuid: 'step-5b', uuid: 'boundary-thought', part: { type: 'think', think: 'next' } }, time: 26_700 },
        { type: 'turn.ended', turnId: 5, reason: 'completed', time: 26_800 },
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
        expect(recoveredTurn).toMatchObject({ state: 'cancelled', prompt: 'typed generated', presentation: { spans: [{ start: 5, end: 15, kind: 'context' }] } });
        expect(recoveredTurn?.kind === 'turn' && recoveredTurn.steps.find((step) => step.retry !== undefined)?.retry)
          .toMatchObject({ failedAttempt: 2, nextAttempt: 3, maxAttempts: 5, delayMs: 100,
            errorName: 'APIConnectionError', errorMessage: 'Connection closed' });
        expect(expected?.items.filter((item) => item.kind === 'marker' && item.marker === 'model.switch')).toEqual([
          expect.objectContaining({ payload: { from: 'example/old', to: 'example/new' } }),
        ]);
        expect(expected?.meta.agent).toMatchObject({ model: 'example/new', thinkingEffort: 'low', contextTokens: 109786, maxContextTokens: 200000, contextUsage: 0.54893 });
        expect(expected?.tasks).toContainEqual(expect.objectContaining({ thinkingEffort: 'high', thinkingEffortExplicit: true, executorId: 'example-acp', executorProtocol: 'acp-v1' }));
        expect(expected?.items.filter((item) => item.kind === 'marker' && item.marker === 'compaction')).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ phase: 'completed', summary: 'committed summary' }) }),
          expect.objectContaining({ payload: expect.objectContaining({ phase: 'cancelled' }) }),
        ]);
        expect(expected?.prompts).toContainEqual(expect.objectContaining({ promptId: 'scheduled-example', originKind: 'cron_job',
          content: [{ type: 'text', text: 'Scheduled message body' }] }));
        expect(checkpoint?.format).toBe(13);
        const boundary = expected?.items.find((item) => item.kind === 'turn' && item.turnId === 't5');
        expect(boundary?.kind === 'turn' ? boundary.steps.map((step) => [step.stepId, step.frames.map((frame) => frame.frameId)]) : []).toEqual([
          ['step-5a', ['before-boundary']],
          ['step-5b', ['steer-boundary', 'steer-cue', 'boundary-thought']],
        ]);
        expect(boundary?.kind === 'turn' ? boundary.steps[1]?.frames[1] : undefined).toMatchObject({
          origin: { kind: 'injection', variant: 'model_steering' },
          delivery: { messageId: 'steer-cue', turnId: 't5', stepId: 'step-5b' },
        });
        expect(expected?.items.find(item => item.kind === 'turn' && item.turnId === 't4')).toMatchObject({ prompt: 'accepted edited text', promptId: 'edited-request', message: { messageId: 'logical-message' } });
        expect(expected?.meta.goal).toMatchObject({ budgetUsed: 200, turnsUsed: 1, wallClockMs: 50 });
        expect(expected?.items.flatMap((item) => item.kind === 'marker' && item.marker === 'goal'
          ? [(item.payload as { change: { kind: string } }).change.kind] : [])).toEqual(['created', 'paused', 'resumed']);
        const originalWire = await fsPromises.readFile(wirePath);
        await query.put('__transcript_projection_checkpoint__', key, {
          ...checkpoint, format,
          snapshot: { ...checkpoint!.snapshot, meta: {}, items: [
            { kind: 'turn', turnId: 't999', ordinal: 999, state: 'completed', origin: { kind: 'user' }, prompt: 'stale phantom', steps: [] },
            { kind: 'marker', markerId: 'stale-accounting', marker: 'goal', payload: { type: 'goal.update', tokensUsed: 100 } },
          ] },
        });
        second = createService();
        expect(await second.readColdSnapshot('s1', 'main')).toEqual(expected);
        expect(starts).toEqual([undefined, undefined]);
        expect(await fsPromises.readFile(wirePath)).toEqual(originalWire);
        second.dispose();
        second = createService();
        expect(await second.readColdSnapshot('s1', 'main')).toEqual(expected);
        expect(starts.at(-1)).toBe(originalWire.byteLength);
        second.dispose();
        await appendFile(wirePath, `${JSON.stringify({ type: 'executor.runtime.update', kind: 'usage', value: { used: 120000, size: 200000 }, time: 25_000 })}\n`);
        second = createService();
        expect((await second.readColdSnapshot('s1', 'main'))?.meta.agent).toMatchObject({ contextTokens: 120000, maxContextTokens: 200000, contextUsage: 0.6 });
        expect(starts.at(-1)).toBe(originalWire.byteLength);
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
    ])('[STAT-R3] completes history across the $name scheduling slice without serving a prefix', async ({ limits }) => {
      const home = await seedWireHomeWithTool();
      const warnings: { bindings: unknown; message: string }[] = [];
      const reads: { start: number; end: number; records: number }[] = [];
      try {
        const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
        const resolved = limits ?? { maxBytes: Math.floor((await fsPromises.stat(wirePath)).size / 2) };
        const baseline = new TranscriptService({ homeDir: home, core: coldCore() });
        const expected = await baseline.readColdSnapshot('s1', 'main');
        baseline.dispose();
        const service = new TranscriptService({
          homeDir: home,
          core: fakeCoreWithAgents(new SessionInteractionService(new TestSessionStateService()), new FakeAgents()),
          coldReadLimits: resolved,
          wireRecordReader: async (path, options) => {
            const read = await streamWireRecords(path, options);
            reads.push({ start: options.startByteOffset ?? 0, end: read.nextByteOffset, records: read.recordCount });
            return read;
          },
          logger: { warn: (bindings, message) => warnings.push({ bindings, message }) },
        });
        const snapshot = await service.readColdSnapshot('s1', 'main');
        expect(snapshot).toEqual(expected);
        expect(snapshot?.toolCallCount).toBe(1);
        expect(snapshot?.toolCallCountKnown).toBe(true);
        expect(reads.length).toBeGreaterThan(1);
        expect(reads.at(-1)?.end).toBe((await fsPromises.stat(wirePath)).size);
        for (const read of reads.filter((read) => read.records > 0)) expect(read.end).toBeGreaterThan(read.start);
        expect(warnings).toEqual([]);

        const store = service.forSessionLive('s1');
        await service.whenReady('s1');
        await service.ensureAgentHistory('s1', 'main');
        const live = store?.getAgent('main')?.snapshot();
        expect(live?.items).toEqual(snapshot?.items);
        expect(live?.toolCallCountKnown).toBe(true);
        expect(service.getMaterializedAgentToolCallCounts('s1', ['main']).get('main')).toBe(1);
        service.dispose();
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


it('reads three cold pages of a few-record large source once, preserving canonical markers, taskrefs, undo and clear', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-page-source-'));
  const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  const wirePath = join(wireDir, 'wire.jsonl');
  const large = 'body 汉😀 '.repeat(100_000);
  const prompt = (turnId: number) => ({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: `${turnId}:${large}` }], origin: { kind: 'user' }, time: turnId + 1000 });
  const records: Record<string, unknown>[] = [prompt(99), { type: 'context.clear' }, prompt(0), prompt(1), prompt(2),
    { type: 'plan_mode.enter', id: 'plan-example', time: 2000 },
    { type: 'task.started', info: { taskId: 'task-example', kind: 'process', description: 'example', status: 'running', startedAt: 2001, endedAt: null }, time: 2001 },
    prompt(3), prompt(4), prompt(5), { type: 'context.undo', count: 1 }];
  await writeFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
  const navigation = new HistoryLocatorStore(database, service);
  service.setHistoryLocatorReader(() => navigation);
  const draft = new AgentTranscriptDraft('main');
  const reducer = new TranscriptFactReducer(draft);
  const adapter = new TranscriptWireAdapter('main', { turn: (id) => draft.getTurn(id), tool: (id) => draft.getToolCall(id), task: (id) => draft.getTask(id) });
  for (const record of records) reducer.apply(adapter.add(record as { type: string }));
  reducer.apply(adapter.finish());
  const key = (item: AgentTranscriptSnapshot['items'][number]) => item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`;
  try {
    const size = (await fsPromises.stat(wirePath)).size;
    expect(size).toBeGreaterThan(4 << 20);
    const firstPageStarted = Date.now();
    const items: AgentTranscriptSnapshot['items'][number][] = [];
    let cursor: string | undefined;
    let pages = 0;
    let firstPageMs = 0;
    for (;;) {
      const beforeTurn = cursor?.startsWith('turn:') === true ? cursor.slice(5) : undefined;
      const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn, beforeItem: beforeTurn === undefined ? cursor : undefined, pageSize: 1 });
      expect(page?.items.length).toBeGreaterThan(0);
      items.unshift(...page!.items);
      if (++pages === 1) {
        expect(service.memoryReport().coldReads.bytes).toBeLessThan(size);
        firstPageMs = Date.now() - firstPageStarted;
      }
      if (page!.next_cursor === undefined) break;
      expect(page!.next_cursor).not.toBe(cursor);
      cursor = page!.next_cursor;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(items.map(key)).toEqual(draft.snapshot().items.map(key));
    expect(items.filter((item) => item.kind === 'turn').map((item) => item.turnId)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(items.some((item) => item.kind === 'marker')).toBe(true);
    expect(items.some((item) => item.kind === 'taskref')).toBe(true);
    expect(service.memoryReport().coldReads.bytes).toBeGreaterThan(0);
    expect(service.memoryReport().coldReads.records).toBeLessThanOrEqual(records.length);
    let last = items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === 't4')!;
    let reads = 0;
    while (last.contentRefs?.length) {
      try {
        last = applyContentSegment(last, (await readSessionViewTranscriptContent(service, 's1', { agentId: 'main', ref: last.contentRefs[0]! }))!);
      } catch (error) { if (!(error instanceof CanonicalEntityPreparingError)) throw error; }
      expect(++reads).toBeLessThan(100);
    }
    expect(last.prompt).toBe(`4:${large}`);
    const readsBeforeAppend = service.memoryReport().coldReads.completed;
    expect(navigation.canonicalReadReport().replayBytes).toBe(0);
    await appendFile(wirePath, `${JSON.stringify({ type: 'context.clear' })}\n${JSON.stringify(prompt(6))}\n`);
    const changed = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
    expect(changed?.items.filter((item) => item.kind === 'turn').map((item) => item.turnId)).toEqual(['t6']);
    expect(service.memoryReport().coldReads.completed).toBeGreaterThan(readsBeforeAppend);
    console.log('cold-page-preview-cache', JSON.stringify({ wireBytes: size, records: records.length, pages, firstPageMs, coldReads: service.memoryReport().coldReads, target: navigation.canonicalReadReport() }));
  } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

it('continues beforeTurn past a leading higher turn when the tail window does not contain the anchor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-anchor-ordinal-'));
  const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  const wirePath = join(wireDir, 'wire.jsonl');
  const prompt = (turnId: number, text: string) => JSON.stringify({
    type: 'turn.prompt', turnId, promptId: `p${turnId}`,
    input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1000 + turnId,
  });
  const lines = [
    prompt(99, 'h'.repeat((8 << 20) + (64 << 10))),
    JSON.stringify({ type: 'context.clear' }),
    prompt(0, 'zero'),
    prompt(1, 'one'),
    prompt(2, 'two'),
    ...Array.from({ length: 12 }, (_, index) => prompt(30 + index, 'p'.repeat(1 << 20))),
    prompt(50, 'tail'),
  ];
  await writeFixtureFile(wirePath, `${lines.join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const tail = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', pageSize: 1 });
    expect(tail?.items.some((item) => item.kind === 'turn' && item.turnId === 't2')).toBe(false);
    const first = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't2', pageSize: 1 });
    expect(first?.items).toEqual([]);
    expect(first?.has_more).toBe(true);
    expect(first?.next_cursor).toBeDefined();
    const older = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't2', pageSize: 1 });
    expect(older?.items[0]).toMatchObject({ kind: 'turn', turnId: 't1' });
    let oldest = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't1', pageSize: 1 });
    if ((oldest?.items.length ?? 0) === 0) {
      expect(oldest?.has_more).toBe(true);
      expect(oldest?.next_cursor).toBeDefined();
      oldest = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't1', pageSize: 1 });
    }
    expect(oldest?.items.find((item) => item.kind === 'turn')).toMatchObject({ turnId: 't0' });
    expect(oldest?.has_more).toBe(false);
    expect(oldest?.next_cursor).toBeUndefined();
    const resident = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't50', pageSize: 1 });
    expect(resident?.items.length).toBeGreaterThan(0);
  } finally {
    service.dispose();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it.each(['cold', 'derived'] as const)('seeks before a long orphan turn in bounded slices and continues its marker page (%s)', async (source) => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-long-orphan-'));
  const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
  await mkdir(dirname(path), { recursive: true });
  const prompt = (turnId: number) => ({ type: 'turn.prompt', turnId, promptId: `p${turnId}`,
    input: [{ type: 'text', text: `original-${turnId}` }], origin: { kind: 'user' }, time: 1000 + turnId });
  for (let index = 0; index < 144; index++) await appendFixtureFile(path, `${JSON.stringify({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) })}\n`);
  await appendFixtureFile(path, [prompt(0), { type: 'turn.ended', turnId: 0, reason: 'completed' },
    { type: 'plan_mode.enter', id: 'older-plan', time: 1001 }, prompt(1),
    { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 1, step: 1, uuid: 's1' } }].map(record => JSON.stringify(record)).join('\n') + '\n');
  for (let index = 0; index < 96; index++) await appendFixtureFile(path, [
    { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: 1, stepUuid: 's1', uuid: `f${index}`, toolCallId: `c${index}`, name: 'Read', args: {} } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${index}`, result: { output: 'x'.repeat(128 << 10), isError: false } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  await appendFixtureFile(path, [ { type: 'turn.ended', turnId: 1, reason: 'completed' }, prompt(2) ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const tail = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', pageSize: 1 });
    expect(tail?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't2' });
    if (source === 'derived') {
      const resident = new AgentTranscript('main');
      resident.apply([{ op: 'reset', agentId: 'main', snapshot: (await service.readColdPageSnapshot('s1', 'main', value => value))! }]);
      vi.spyOn(service, 'forSessionLive').mockReturnValue({ agents: () => [] } as unknown as TranscriptStore);
      vi.spyOn(service, 'ensureAgentHistory').mockResolvedValue(resident);
      vi.spyOn(service, 'verifyTranscriptLiveCoverage').mockResolvedValue(false);
      vi.spyOn(service, 'getTranscriptCursor').mockReturnValue({ epoch: 'resident-test', seq: 7 });
    }
    const before = service.memoryReport().coldReads.bytes;
    const pending = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: 'turn:t1', pageSize: 1 });
    expect(pending).toMatchObject({ items: [], has_more: true, read: { source, readiness: 'preparing' } });
    expect(pending?.next_cursor).toBeDefined();
    expect(JSON.parse(Buffer.from(pending!.next_cursor!, 'base64url').toString('utf8'))).toMatchObject({ anchor: 'turn:t1', source });
    const marker = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: pending!.next_cursor!, pageSize: 1 });
    expect(marker?.items).toContainEqual(expect.objectContaining({ kind: 'marker', markerId: 'wire:v2:plan_mode.enter:older-plan' }));
    const locatedBytes = service.memoryReport().coldReads.bytes;
    expect(locatedBytes - before).toBeLessThan(12 << 20);
    const older = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: 'marker:wire:v2:plan_mode.enter:older-plan', pageSize: 1 });
    expect(older?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't0', prompt: 'original-0' });
    expect(service.memoryReport().coldReads.bytes - locatedBytes).toBeLessThan(2 << 20);
    expect(service.memoryReport().coldWindowBytes).toBeLessThanOrEqual(32 << 20);
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

it('continues the first unverified cold page from its tail turn without a second full wire read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-unverified-tail-'));
  const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  const wirePath = join(wireDir, 'wire.jsonl');
  const filler = 'pad '.repeat(16_384);
  const tail = `tail 汉😀 ${'body '.repeat(80_000)}`;
  const prompt = (turnId: number, text: string) => ({
    type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text }], origin: { kind: 'user' }, time: turnId + 1000,
  });
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < 160; index += 1) records.push(prompt(index, `${index}:${filler}`));
  records.push(prompt(160, tail));
  await writeFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
  const navigation = new HistoryLocatorStore(database, service);
  service.setHistoryLocatorReader(() => navigation);
  try {
    const size = (await fsPromises.stat(wirePath)).size;
    expect(size).toBeGreaterThan(8 << 20);
    const signal = new AbortController().signal;
    const screen = service as unknown as {
      readScreenSnapshot(sessionId: string, agentId: string): Promise<AgentTranscriptSnapshot | undefined>;
    };
    const openStarted = Date.now();
    const opened = await screen.readScreenSnapshot('s1', 'main');
    const openMs = Date.now() - openStarted;
    const openedTail = opened?.items.find((item) => item.kind === 'turn' && item.prompt?.startsWith('tail ') === true);
    if (openedTail?.kind !== 'turn') throw new Error('Expected the tail turn before the first page');
    expect(service.memoryReport().coldReads.bytes).toBeLessThan(size);
    expect(service.memoryReport().coldReads.completed).toBe(1);
    const pageStarted = Date.now();
    const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', signal });
    const firstPageMs = Date.now() - pageStarted;
    const shown = page?.items.find((item) => item.kind === 'turn' && item.prompt?.startsWith('tail ') === true);
    if (shown?.kind !== 'turn') throw new Error('Expected the bounded tail turn');
    expect(shown.contentRefs?.length).toBeGreaterThan(0);
    expect(service.memoryReport().coldReads.bytes).toBeLessThan(size);
    expect(service.memoryReport().coldReads.bytes).toBeGreaterThan(0);
    expect(page?.read).toMatchObject({ readiness: 'partial', reason: 'source_unverified' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(readSessionViewTranscriptContent(service, 's1', {
      agentId: 'main', ref: shown.contentRefs![0]!, signal: cancelled.signal,
    })).rejects.toThrow();
    expect(service.memoryReport().coldReads.completed).toBe(1);
    let last: TranscriptTurn = shown;
    let reads = 0;
    while (last.contentRefs?.length) {
      const segment = await readSessionViewTranscriptContent(service, 's1', { agentId: 'main', ref: last.contentRefs[0]!, signal });
      expect(segment).toBeDefined();
      last = applyContentSegment(last, segment!);
      expect(++reads).toBeLessThan(100);
    }
    expect(last.prompt).toBe(tail);
    expect(service.memoryReport().coldReads.bytes).toBeLessThan(size);
    const readsBeforeAppend = service.memoryReport().coldReads.completed;
    await appendFile(wirePath, `${JSON.stringify(prompt(161, 'appended-after-tail'))}\n`);
    const changed = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', signal });
    expect(changed?.items.some((item) => item.kind === 'turn' && item.prompt === 'appended-after-tail')).toBe(true);
    expect(service.memoryReport().coldReads.completed).toBeGreaterThan(readsBeforeAppend);
    expect(navigation.canonicalReadReport().replayBytes).toBe(0);
    console.log('current-first-screen', JSON.stringify({
      wireBytes: size, records: records.length, openMs, firstPageMs,
      openReads: { bytes: service.memoryReport().coldReads.bytes, records: service.memoryReport().coldReads.records, completed: service.memoryReport().coldReads.completed },
      tailTurnId: openedTail.turnId, read: page?.read, hasMore: page?.has_more,
    }));
  } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});


it.each(['beforeItem', 'afterItem'] as const)('honors the requested page size for %s marker continuations', async (direction) => {
  const transcript = new AgentTranscript('main');
  transcript.apply(Array.from({ length: 80 }, (_, index) => ({ op: 'marker.upsert' as const,
    item: { kind: 'marker' as const, markerId: `m${index}`, marker: 'compaction' as const } })));
  const service = {
    forSessionLive: () => ({ agents: () => [] }), ensureAgentHistory: async () => transcript,
    verifyTranscriptLiveCoverage: async () => false, isTranscriptLiveCoverageVerified: () => false,
    getTranscriptCursor: () => ({ epoch: 'item-page-size', seq: 0 }),
  } as unknown as TranscriptService;
  const response = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', [direction]: 'marker:m40', pageSize: 20 });
  expect(response?.items.map((item) => item.kind === 'marker' ? item.markerId : '')).toEqual(
    Array.from({ length: 20 }, (_, index) => `m${index + (direction === 'beforeItem' ? 20 : 41)}`));
  expect(response?.has_more).toBe(true);
  expect(JSON.parse(Buffer.from(response!.next_cursor!, 'base64url').toString('utf8'))).toEqual({
    v: 2,
    agentId: 'main',
    source: 'live',
    anchor: direction === 'beforeItem' ? 'marker:m20' : 'marker:m60',
    epoch: 'item-page-size',
  });
});

it.each([0, 12])('continues a budget-clipped resident baseline from its tail boundary without skipping early-marker history (%i trailing headers)', async (trailingHeaders) => {
  const full = new AgentTranscript('main');
  const ops: TranscriptOperation[] = [];
  for (let ordinal = 0; ordinal < 820; ordinal += 1) {
    ops.push({ op: 'turn.upsert', turn: { kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, prompt: `exact ${ordinal}` } });
    ops.push({ op: 'marker.upsert', item: { kind: 'marker', markerId: `m${ordinal}`, marker: 'compaction', at: new Date(ordinal * 1000).toISOString() } });
  }
  for (let index = 0; index < trailingHeaders; index += 1) {
    ops.push({ op: 'marker.upsert', item: { kind: 'marker', markerId: `trailing-${index}-${'x'.repeat(100_000)}`, marker: 'compaction' } });
  }
  full.apply(ops);
  const canonical = full.snapshot();
  full.releaseDurableHistory(canonical, { tailTurns: 20, maxBytes: 1 });
  expect(full.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId)).toEqual(['t819']);
  const service = {
    readColdPageSnapshot: async () => full.snapshot(),
    reconcileQuestionSnapshot: (_session: string, snapshot: AgentTranscriptSnapshot) => snapshot,
    forSessionLive: () => ({ agents: () => [] }),
    ensureAgentHistory: async () => full,
    verifyTranscriptLiveCoverage: async () => false,
    isTranscriptLiveCoverageVerified: () => false,
    readFullAgentSnapshot: async () => canonical,
    getTranscriptCursor: () => ({ epoch: 'resident-test', seq: 7 }),
  } as unknown as TranscriptService;
  const baseline = await readColdSessionViewBaseline(service, 's1', 'main', 'delta', new AbortController().signal);
  const items = [...baseline!.snapshot.items];
  expect(items).toEqual(canonical.items.slice(canonical.items.length - items.length));
  expect(items.length).toBeLessThan(canonical.items.length);
  const expectedAnchor = items[0]!.kind === 'turn' ? 'turn:t819' : `marker:${items[0]!.kind === 'marker' ? items[0]!.markerId : ''}`;
  const cursorValue = baseline!.snapshot.olderCursor!;
  expect(cursorValue.length).toBeLessThanOrEqual(512);
  if (expectedAnchor.length <= 512) expect(cursorValue).toBe(expectedAnchor);
  else expect(cursorValue.startsWith('~')).toBe(true);
  if (trailingHeaders === 0) expect(baseline!.snapshot.olderCursor).toBe('turn:t819');
  else expect(items.some((item) => item.kind === 'turn')).toBe(false);
  let cursor = baseline!.snapshot.olderCursor;
  const requests: string[] = [];
  while (cursor !== undefined) {
    requests.push(cursor);
    const response = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: cursor, pageSize: 100 });
    expect(response!.items.length).toBeGreaterThan(0);
    expect(response!.cursor).toEqual({ epoch: 'resident-test', seq: 7 });
    items.unshift(...response!.items);
    cursor = response!.next_cursor;
    expect(requests.length).toBeLessThan(100);
  }
  const key = (item: AgentTranscriptSnapshot['items'][number]) => item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`;
  expect(items.map(key)).toEqual(canonical.items.map(key));
  expect(new Set(items.map(key)).size).toBe(items.length);
  expect(items.filter((item) => item.kind === 'turn').map((item) => item.turnId)).toEqual(Array.from({ length: 820 }, (_, ordinal) => `t${ordinal}`));
  const staleCursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'derived', anchor: 'marker:missing', epoch: 'resident-test' }), 'utf8').toString('base64url');
  const stale = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: staleCursor, pageSize: 100 });
  expect(stale).toMatchObject({ items: [], read: { source: 'derived', readiness: 'partial', reason: 'stale_cursor' } });
});


it.each([{ turnId: 0, prepared: false, warmed: false }, { turnId: 7, prepared: true, warmed: false },
  { turnId: 7, prepared: false, warmed: false }, { turnId: 0, prepared: false, warmed: true },
  { turnId: 7, prepared: true, warmed: true }])(
  'recovers only the opening header of a long orphan tail (%j)', async ({ turnId, prepared, warmed }) => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-orphan-header-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const wirePath = join(wireDir, 'wire.jsonl');
    const records: Record<string, unknown>[] = [];
    for (let id = 0; id <= turnId; id += 1) {
      if (id === 7) for (let index = 0; index < 32; index += 1) records.push({ type: 'fixture.padding', padding: 'before'.repeat(13_108) });
      records.push({ type: 'turn.prompt', turnId: id,
        promptId: `request-${id}`, input: [{ type: 'text', text: `opening-${id}` }], origin: { kind: 'user' }, time: 1000 + id });
    }
    for (let index = 0; index < 145; index += 1) records.push({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) });
    records.push({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId, uuid: 'tail-step', step: 1 }, time: 2000 },
      { type: 'turn.ended', turnId, reason: 'completed', time: 3000 });
    await writeFile(wirePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    const service = new TranscriptService({ homeDir: home, core: coldCore() });
    const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
    const navigation = new HistoryLocatorStore(database, service);
    service.setHistoryLocatorReader(() => navigation);
    try {
      if (prepared) { while (!(await navigation.scan('s1', 'main'))?.complete) {} }
      if (warmed) {
        const baseline = await readColdSessionViewBaseline(service, 's1', 'main', 'delta', new AbortController().signal);
        expect(baseline?.snapshot.items.find(item => item.kind === 'turn')).toMatchObject({ prompt: undefined, origin: { kind: 'other' } });
        expect(service.memoryReport().coldReads.completed).toBe(1);
      }
      const projectionBefore = navigation.canonicalReadReport().projectionBytes;
      const readsBefore = service.memoryReport().coldReads;
      const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
      const turn = page?.items.filter(item => item.kind === 'turn').find(item => item.turnId === `t${turnId}`);
      expect(turn?.steps.length).toBeGreaterThan(0);
      if (turnId === 0 || prepared) expect(turn).toMatchObject({ prompt: `opening-${turnId}`, promptId: `request-${turnId}`, origin: { kind: 'user' }, state: 'completed' });
      else expect(turn).toMatchObject({ prompt: undefined, origin: { kind: 'other' } });
      expect(page?.read).toMatchObject({ readiness: 'partial', reason: 'source_unverified' });
      expect(page?.has_more).toBe(true);
      expect(page?.next_cursor).toBeDefined();
      expect(service.memoryReport().coldReads.bytes - readsBefore.bytes).toBeLessThan(3 << 20);
      expect(service.memoryReport().coldReads.completed - readsBefore.completed).toBe(turnId === 0 ? 2 : 1);
      expect(navigation.canonicalReadReport().projectionBytes).toBe(projectionBefore);
      expect(navigation.canonicalReadReport().replayBytes).toBeLessThan(1024);
      if (turnId === 7 && !prepared) {
        let continued = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: page!.next_cursor! });
        if (continued?.items.length === 0) continued = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: continued.next_cursor ?? page!.next_cursor! });
        expect(continued?.items.find(item => item.kind === 'turn' && item.turnId === 't7')).toMatchObject({ prompt: 'opening-7', origin: { kind: 'user' } });
        expect(JSON.parse(Buffer.from(continued!.next_cursor!, 'base64url').toString('utf8'))).toMatchObject({ anchor: 'turn:t7', refreshedTurn: 't7' });
        const preceding = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: continued!.next_cursor! });
        expect(preceding?.items.some(item => item.kind === 'turn' && item.turnId === 't7')).toBe(false);
        expect(preceding?.items.some(item => item.kind === 'turn' && item.turnId === 't6')).toBe(true);
      }
      const cancelled = new AbortController(); cancelled.abort();
      await expect(navigation.readCanonicalTurnHeader('s1', 'main', `t${turnId}`, cancelled.signal)).rejects.toThrow();
      if (prepared) {
        const header = await navigation.readCanonicalTurnHeader('s1', 'main', `t${turnId}`);
        expect(header.status).toBe('found');
        await writeFile(wirePath, (await fsPromises.readFile(wirePath, 'utf8')).replace(`opening-${turnId}`, `changed-${turnId}`));
        await expect(navigation.readCanonicalTurnHeader('s1', 'main', `t${turnId}`)).rejects.toThrow('history_source_changed');
      }
    } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

it.each(['cold', 'derived'] as const)('keeps an earlier prompt on the same turn when the cold tail already shows that turn (%s)', async (source) => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-same-turn-prefix-'));
  const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  const prompt = {
    type: 'turn.prompt', turnId: 0, promptId: 'same-turn-prefix',
    input: [{ type: 'text', text: 'visible-prefix' }], origin: { kind: 'user' }, time: 1_000,
    padding: 'p'.repeat(2 << 20),
  };
  const padding = Array.from({ length: 145 }, () => ({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) }));
  const tail = [
    { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 0, uuid: 'same-turn-step', step: 1 }, time: 2_000 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 3_000 },
  ];
  await writeFile(join(wireDir, 'wire.jsonl'), `${[prompt, ...padding, ...tail].map(record => JSON.stringify(record)).join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
    const tailTurn = page?.items.find(item => item.kind === 'turn' && item.turnId === 't0');
    expect(tailTurn).toMatchObject({ prompt: undefined, origin: { kind: 'other' } });
    expect(page?.has_more).toBe(true);
    let cursor = page?.next_cursor;
    if (source === 'derived') {
      const resident = new AgentTranscript('main');
      resident.apply([{ op: 'reset', agentId: 'main', snapshot: (await service.readColdPageSnapshot('s1', 'main', value => value))! }]);
      vi.spyOn(service, 'forSessionLive').mockReturnValue({ agents: () => [] } as unknown as TranscriptStore);
      vi.spyOn(service, 'ensureAgentHistory').mockResolvedValue(resident);
      vi.spyOn(service, 'verifyTranscriptLiveCoverage').mockResolvedValue(false);
      vi.spyOn(service, 'getTranscriptCursor').mockReturnValue({ epoch: 'resident-test', seq: 7 });
      cursor = (await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeTurn: 't1' }))?.next_cursor;
    }
    let recovered: typeof tailTurn;
    for (let attempt = 0; attempt < 16 && cursor !== undefined && recovered === undefined; attempt += 1) {
      const continued = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: cursor });
      recovered = continued?.items.find(item => item.kind === 'turn' && item.turnId === 't0' && item.prompt === 'visible-prefix');
      cursor = continued?.next_cursor;
    }
    expect(recovered).toMatchObject({ prompt: 'visible-prefix', promptId: 'same-turn-prefix', origin: { kind: 'user' } });
    if (source === 'derived') {
      expect(recovered).toMatchObject({ state: 'completed' });
      expect(recovered?.kind === 'turn' ? recovered.steps.length : 0).toBeGreaterThan(0);
    }
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

it('keeps a truly headerless long tail unknown with a usable continuation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-headerless-'));
  const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  await writeFile(join(wireDir, 'wire.jsonl'), `${Array.from({ length: 145 }, () => JSON.stringify({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) })).join('\n')}\n${JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 0, uuid: 'orphan-step', step: 1 } })}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
    const orphan = page?.items.find(item => item.kind === 'turn');
    expect(orphan).toMatchObject({ origin: { kind: 'other' } });
    expect(orphan?.prompt).toBeUndefined();
    expect(page?.read).toMatchObject({ readiness: 'partial', reason: 'source_unverified' });
    expect(page?.has_more).toBe(true);
    expect(page?.next_cursor).toBeDefined();
    expect(service.memoryReport().coldReads.completed).toBe(2);
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});


it('opens an indivisible prompt larger than the cold alignment window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-cold-window-'));
  const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
  await mkdir(dirname(wirePath), { recursive: true });
  await writeFixtureFile(wirePath, `${JSON.stringify({ type: 'turn.prompt', turnId: 0, promptId: 'giant-prompt', input: [{ type: 'text', text: 'header '.repeat(1_600_000) }], origin: { kind: 'user' } })}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main' });
    expect(page?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't0', promptId: 'giant-prompt', contentRefs: expect.any(Array) });
    expect(jsonBytes(page)).toBeLessThanOrEqual(64 << 10);
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

it('reopens the true tail after a sliding cold window reaches the beginning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-cold-window-'));
  const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
  await mkdir(dirname(wirePath), { recursive: true });
  await writeFixtureFile(wirePath, `${Array.from({ length: 48 }, (_, turnId) => JSON.stringify({ type: 'turn.prompt', turnId, promptId: `sliding-${turnId}`, input: [{ type: 'text', text: `${turnId}:${'x'.repeat(256 << 10)}` }], origin: { kind: 'user' } })).join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    await service.readColdPageSnapshot('s1', 'main', source => source);
    for (let count = 0; await service.coldHistoryTruncated('s1', 'main'); count++) {
      expect(count).toBeLessThan(64);
      await service.readColdPageSnapshot('s1', 'main', source => source, undefined, true, 8 << 20);
    }
    const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', pageSize: 1 });
    expect(page?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't47' });
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

it('reads old prompt detail and its collection outside the cold tail window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-cold-window-'));
  const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
  await mkdir(dirname(wirePath), { recursive: true });
  const prompt = { type: 'prompt.enqueued', promptId: 'old-queued', message: { role: 'user', content: [{ type: 'text', text: 'retained queued input' }], origin: { kind: 'user' } } };
  await writeFixtureFile(wirePath, `${[prompt, ...Array.from({ length: 145 }, () => ({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) })), { type: 'turn.prompt', turnId: 1, promptId: 'tail', input: [{ type: 'text', text: 'tail' }], origin: { kind: 'user' } }].map(record => JSON.stringify(record)).join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    const full = await service.readColdSnapshot('s1');
    expect(full?.prompts.find(entry => entry.promptId === 'old-queued')).toBeDefined();
    const detail = await readSessionViewTranscriptDetail(service, 's1', { agentId: 'main', kind: 'prompt', id: 'old-queued' });
    expect(detail).toMatchObject({ kind: 'prompt', prompt: { promptId: 'old-queued' } });
    const entity = await readSessionViewCanonicalEntity(service, 's1', { agentId: 'main', ref: { source: { kind: 'prompt', id: 'old-queued' } } });
    expect(entity).toMatchObject({ promptId: 'old-queued' });
    const list = await readSessionViewTranscriptDetails(service, 's1', { agentId: 'main', kind: 'prompt' });
    expect(list?.items.some(entry => 'promptId' in entry && entry.promptId === 'old-queued')).toBe(true);
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});


it('accounts for unprojected wire bytes and bounds anchor windows across cold sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-window-residency-'));
  const prompt = (turnId: number, text: string) => ({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text }], origin: { kind: 'user' } });
  const records = [...Array.from({ length: 144 }, () => ({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) })), prompt(1, 'older '.repeat(50_000)), prompt(2, 'anchor'), ...Array.from({ length: 16 }, () => ({ type: 'fixture.padding', padding: 'y'.repeat(64 << 10) })), prompt(3, 'tail')];
  const wire = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  try {
    for (let index = 0; index < 6; index++) {
      const sessionId = `cold-${index}`;
      const wirePath = join(home, 'sessions', 'ws', sessionId, 'agents', 'main', 'wire.jsonl');
      await mkdir(dirname(wirePath), { recursive: true });
      await writeFixtureFile(wirePath, wire);
      await service.readColdPageSnapshot(sessionId, 'main', source => source);
      expect(service.memoryReport().coldWindowBytes).toBeGreaterThan(1 << 20);
      let anchored = await service.readAnchoredColdSnapshot(sessionId, 'main', 't2');
      if (anchored !== undefined && service.anchorReadState(anchored) === 'pending') anchored = await service.readAnchoredColdSnapshot(sessionId, 'main', 't2');
      expect(anchored?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't1' });
    }
    expect(service.memoryReport()).toMatchObject({ coldWindowEntries: 4, anchorWindowEntries: 4 });
    expect(service.memoryReport().coldWindowBytes).toBeLessThanOrEqual(32 << 20);
    expect(service.memoryReport().anchorWindowBytes).toBeLessThanOrEqual(32 << 20);
    service.dropSession('cold-5');
    expect(service.memoryReport()).toMatchObject({ coldWindowEntries: 3, anchorWindowEntries: 3 });
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});


it('shares the history lane across anchored agent scans and cancels queued and active readers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-anchor-lane-'));
  const prompt = (turnId: number) => ({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: `turn-${turnId}` }], origin: { kind: 'user' } });
  const wire = `${[prompt(1), prompt(2), { type: 'fixture.padding', padding: 'x'.repeat(9 << 20) }].map(record => JSON.stringify(record)).join('\n')}\n`;
  let hold = true;
  let holdWindow = false;
  let windowWaiting = false;
  let active = 0;
  let peak = 0;
  const reader: NonNullable<TranscriptServiceDeps['wireRecordReader']> = async (path, options) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      const windowRead = holdWindow && options.maxBytes === undefined;
      if (windowRead) windowWaiting = true;
      if (hold || windowRead) await new Promise<never>((_resolve, reject) => {
        const signal = options.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return await streamWireRecords(path, options);
    } finally { active -= 1; }
  };
  const service = new TranscriptService({ homeDir: home, core: coldCore(), wireRecordReader: reader });
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  let flights: Promise<unknown>[] = [];
  try {
    for (let n = 0; n < 12; n++) {
      const path = join(home, 'sessions/ws/s1/agents', `child-${n}`, 'wire.jsonl');
      await mkdir(dirname(path), { recursive: true });
      await writeFixtureFile(path, wire);
    }
    const results: unknown[] = [];
    flights = controllers.map((controller, n) => service.readAnchoredColdSnapshot('s1', `child-${n}`, 't2', controller.signal)
      .catch(error => { results.push(error); return error; }));
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results).toEqual([expect.objectContaining({ code: 'session.busy' }), expect.objectContaining({ code: 'session.busy' })]);
    expect(service.memoryReport().readLane).toMatchObject({ active: 2, queued: 8, peak: 2 });
    expect(peak).toBe(2);
    controllers.forEach(controller => controller.abort(new Error('reader cancelled')));
    await Promise.all(flights);
    expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 });
    expect(active).toBe(0);
    hold = false;
    const pages = await Promise.all([0, 1].map(n => service.readAnchoredColdSnapshot('s1', `child-${n}`, 't2')));
    expect(pages.map(page => page?.items.find(item => item.kind === 'turn')?.turnId)).toEqual(['t1', 't1']);
    holdWindow = true;
    const windowController = new AbortController();
    controllers.push(windowController);
    const cancelledBefore = service.memoryReport().coldReads.cancelled;
    const windowRead = service.readAnchoredColdSnapshot('s1', 'child-2', 't2', windowController.signal);
    flights.push(windowRead.catch(error => error));
    await vi.waitFor(() => { expect(windowWaiting).toBe(true); });
    windowController.abort(new Error('anchor window cancelled'));
    await expect(windowRead).rejects.toThrow('anchor window cancelled');
    expect(service.memoryReport().coldReads.cancelled).toBe(cancelledBefore + 1);
    expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 });
    expect(active).toBe(0);
    holdWindow = false;
    hold = true;
    flights = [2, 3, 4].map(n => service.readAnchoredColdSnapshot('s1', `child-${n}`, 't2').catch(error => error));
    await vi.waitFor(() => expect(service.memoryReport().readLane).toMatchObject({ active: 2, queued: 1 }));
    service.dispose();
    const closed = await Promise.all(flights);
    expect(closed.every(error => error instanceof Error && error.name === 'AbortError')).toBe(true);
    expect(service.memoryReport().readLane).toMatchObject({ active: 0, queued: 0 });
    expect(active).toBe(0);
  } finally {
    controllers.forEach(controller => controller.abort());
    service.dispose();
    await Promise.all(flights);
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 30_000);

it('rejects stale indexed turn bytes after a wire rewrite and uses bounded anchor seeking', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-anchor-proof-'));
  const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
  const prompt = (turnId: number, text: string) => JSON.stringify({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text }], origin: { kind: 'user' } }) + '\n';
  const padding = Array.from({ length: 145 }, () => JSON.stringify({ type: 'fixture.padding', padding: 'x'.repeat(64 << 10) }) + '\n').join('');
  const initial = prompt(1, 'initial') + prompt(2, 'anchor') + padding;
  const reads: number[] = [];
  const service = new TranscriptService({ homeDir: home, core: coldCore(), wireRecordReader: async (path, options) => {
    reads.push(options.startByteOffset ?? 0);
    return streamWireRecords(path, options);
  } });
  const database = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
  const navigation = new HistoryLocatorStore(database, service);
  service.setHistoryLocatorReader(() => navigation);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFixtureFile(path, initial);
    while (!(await navigation.scan('s1', 'main'))?.complete) {}
    const indexed = Buffer.byteLength(prompt(1, 'initial'));
    expect(await navigation.indexedTurnByte('s1', 'main', 't2')).toBe(indexed);
    await appendFixtureFile(path, prompt(3, 'appended'));
    expect(await navigation.indexedTurnByte('s1', 'main', 't2')).toBe(indexed);
    const rewritten = 'rewritten opening '.repeat(400);
    await writeFixtureFile(path, prompt(1, rewritten) + prompt(2, 'anchor') + padding);
    expect(await navigation.indexedTurnByte('s1', 'main', 't2')).toBeUndefined();
    reads.length = 0;
    const page = await service.readAnchoredColdSnapshot('s1', 'main', 't2');
    expect(reads[0]).toBe(0);
    expect(page?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't1', prompt: rewritten });
    expect(service.anchorReadState(page!)).toBe('window');
  } finally { service.dispose(); await database.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}, 30_000);


it('does not retain an oversized sole cold window and still advances to older records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-oversized-window-'));
  const path = join(home, 'sessions/ws/s1/agents/main/wire.jsonl');
  const prompt = (turnId: number) => JSON.stringify({ type: 'turn.prompt', turnId, promptId: `p${turnId}`, input: [{ type: 'text', text: `turn-${turnId}` }], origin: { kind: 'user' } }) + '\n';
  let raw: WeakRef<object> | undefined;
  const service = new TranscriptService({ homeDir: home, core: coldCore(), wireRecordReader: (file, options) => streamWireRecords(file, {
    ...options, onRecord: (record, span) => {
      if (record.type === 'fixture.large') raw = new WeakRef(record);
      return options.onRecord(record, span);
    },
  }) });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFixtureFile(path, prompt(1));
    await appendFixtureFile(path, '{"type":"fixture.large","padding":"');
    for (let chunk = 0; chunk < 34; chunk++) await appendFixtureFile(path, 'x'.repeat(1 << 20));
    await appendFixtureFile(path, '"}\n' + prompt(2));
    const initial = await service.readColdPageSnapshot('s1', 'main', source => source);
    expect(initial?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't2' });
    expect(service.memoryReport().coldWindowBytes).toBeLessThanOrEqual(32 << 20);
    if (globalThis.gc !== undefined) {
      for (let pass = 0; pass < 4; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
      expect(raw?.deref()).toBeUndefined();
    }
    const older = await service.readColdPageSnapshot('s1', 'main', source => source, undefined, true);
    expect(older?.items.find(item => item.kind === 'turn')).toMatchObject({ turnId: 't1', prompt: 'turn-1' });
    let originalLength = 0;
    await streamWireRecords(path, { onRecord: record => { if (record.type === 'fixture.large') originalLength = (record['padding'] as string).length; } });
    expect(originalLength).toBe(34 << 20);
    service.dropSession('s1');
    if (globalThis.gc !== undefined) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc(); }
    expect(service.memoryReport()).toMatchObject({ coldWindowBytes: 0, coldWindowEntries: 0 });
    console.log('oversized-window-release', { heapAfterDrop: process.memoryUsage().heapUsed, maxRss: process.resourceUsage().maxRSS * 1024, gc: globalThis.gc !== undefined });
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}, 30_000);


it.each([{ count: 1200, chars: 8192 }, { count: 384, chars: 65536 }])('pages a synthetic long wire of $count turns with $chars characters to its first record exactly once across bounded cold windows', async ({ count, chars }) => {
  const home = await mkdtemp(join(tmpdir(), 'transcript-page-complete-'));
  const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
  await mkdir(dirname(wirePath), { recursive: true });
  const records = Array.from({ length: count }, (_, turnId) => JSON.stringify({ type: 'turn.prompt', turnId,
    promptId: `history-${turnId}`, input: [{ type: 'text', text: `Record ${turnId} ${'x'.repeat(chars)}` }], origin: { kind: 'user' }, time: 1000 + turnId }));
  await writeFixtureFile(wirePath, `${records.join('\n')}\n`);
  const service = new TranscriptService({ homeDir: home, core: coldCore() });
  const pages: string[][] = [];
  try {
    let cursor: string | undefined;
    for (let request = 0; request < count; request++) {
      const page = await readSessionViewTranscriptPage(service, 's1', { agentId: 'main', beforeItem: cursor, pageSize: 20 });
      expect(page).toBeDefined();
      pages.push(page!.items.flatMap(item => item.kind === 'turn' ? [item.turnId] : []));
      if (!page!.has_more) break;
      expect(page!.next_cursor).toBeDefined();
      cursor = page!.next_cursor;
    }
    const actual = pages.toReversed().flat();
    expect(actual).toEqual(Array.from({ length: count }, (_, ordinal) => `t${ordinal}`));
    expect(new Set(actual).size).toBe(count);
    expect(service.memoryReport().coldWindowBytes).toBeLessThanOrEqual(8 << 20);
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}, 60_000);
