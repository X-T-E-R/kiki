import { channel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  type Event2,
  IAgentBlobService,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
  ICpuWorkerService,
  IFileSystemStorageService,
  IAtomicDocumentStore,
  IFileSystemStorageService,
  IAgentTaskService,
  IEventBus,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentUsageService,
  ILogService,
  ISessionActivityView,
  ISessionDeliveryService,
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionQuestionService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLifecycleService,
  IWireService,
  ISessionManager,
  ITelemetryService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
  type ContextMessage,
} from '@kiki/agent-core-v2';
import { sessionSnapshotResponseSchema } from '../src/protocol/rest-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { resolveSessionBindingFacts } from '../src/routes/sessions';
import { usageRuntime } from '../src/usage/usageRuntime';
import * as panelCapabilities from '../src/routes/agentPanelCapabilities';
import { assembleBrowseSnapshot, assembleBrowseSnapshotSource, assembleSnapshot, readBrowseSnapshotContent, registerSnapshotRoutes } from '../src/routes/snapshot';
import { sessionAgentRoster } from '../src/routes/sessionAgentRoster';
import { contentRevision } from '../src/transport/klient/contentRevision';
import { readColdMainWireProjection } from '../src/services/snapshot/coldSnapshotSource';
import { applyContentSegment, jsonBytes, type ContentSegment } from '@kiki/transcript';
import { readContentSegment } from '../src/transport/klient/boundedContent';
import { type RunningServer, startServer } from '../src/start';
import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';
import * as messageHistory from '../src/services/messages/messageHistory';

function fakeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get<T>(id: unknown): T {
      if (!services.has(id)) {
        throw new Error(`unexpected service request: ${String(id)}`);
      }
      return services.get(id) as T;
    },
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('server-v2 snapshot route enrichment', () => {
  it('reads only the selected cold receipt sidecar and keeps roster reads on previews', async () => {
    const receipt = 'complete receipt '.repeat(512);
    const sidecar = 'agent-outcomes/1234-abcd.json';
    const meta = { id: 's1', createdAt: 1, updatedAt: 2, archived: false, agents: {
      child: { type: 'sub' as const, taskId: 'task-1', status: 'completed' as const, completedAt: 2,
        resultSummary: receipt.slice(0, 2048), outcomeRef: sidecar },
      other: { type: 'sub' as const, resultSummary: 'other preview', outcomeRef: 'agent-outcomes/5678-abcd.json' },
    } };
    let missing = false;
    const get = vi.fn(async (_scope: string, key: string) => key === 'state.json' ? meta
      : missing ? undefined : { version: 1, resultSummary: receipt });
    let metaRevision = 1;
    const core = { accessor: fakeAccessor([
      [ISessionManager, { get: () => undefined }],
      [ISessionIndex, { get: async () => ({ workspaceId: 'ws' }) }],
      [IAtomicDocumentStore, { get }],
      [IFileSystemStorageService, { stat: async () => ({ size: 1, revision: String(metaRevision) }) }],
    ]) };
    const candidates = sessionAgentRoster('s1', meta);
    const index = candidates.findIndex((agent) => agent.id === 'child');
    const ref = { source: { kind: 'snapshot' as const, id: '' }, path: ['subagents', index, 'output_preview'],
      kind: 'text' as const, offset: 0, total: receipt.length, revision: contentRevision(receipt) };
    const segment = await readBrowseSnapshotContent(core as never, {} as never, 's1', 'main', ref);
    expect(segment?.value).toBe(receipt);
    expect(get.mock.calls.filter(([, key]) => key.startsWith('agent-outcomes/')).map(([, key]) => key)).toEqual([sidecar]);
    get.mockClear();
    const rosterRef = { source: ref.source, path: ['subagents'], kind: 'array' as const, offset: 0,
      total: candidates.length, revision: contentRevision(candidates.map((agent) => agent.agent_id ?? agent.id)) };
    await readBrowseSnapshotContent(core as never, {} as never, 's1', 'main', rosterRef);
    expect(get.mock.calls.map(([, key]) => key)).toEqual([]);
    metaRevision = 2;
    await readBrowseSnapshotContent(core as never, {} as never, 's1', 'main', rosterRef);
    expect(get.mock.calls.map(([, key]) => key)).toEqual(['state.json']);
    missing = true;
    get.mockClear();
    const preview = receipt.slice(0, 2048);
    const fallback = await readBrowseSnapshotContent(core as never, {} as never, 's1', 'main', {
      ...ref, total: preview.length, revision: contentRevision(preview),
    });
    expect(fallback?.value).toBe(preview);
  });

  it.each(['failed', 'cancelled'] as const)('session loading timing records live snapshot acquisition %s', async (outcome) => {
    const gate = deferred();
    const entered = deferred();
    const expected = new Error('private-source-content');
    const logger = { warn: vi.fn() };
    const cancellation = new AbortController();
    const acquire = vi.fn(async () => { entered.resolve(); await gate.promise; throw expected; });
    const core = { accessor: fakeAccessor([
      [ISessionManager, { get: () => ({}), acquire }],
      [ITelemetryService, { withContext: () => ({ track2: vi.fn() }) }],
    ]) };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = assembleBrowseSnapshot(core as never, {} as never, 's1', {
      logger, signal: cancellation.signal, requestId: 'snapshot-request',
    }).catch((error: unknown) => error);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'snapshot_acquire', outcome: 'pending',
        sessionId: 's1', requestId: 'snapshot-request', durationMs: 1_000 }), 'session view phase');
      if (outcome === 'cancelled') cancellation.abort();
      gate.resolve();
      expect(await pending).toBe(expected);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'snapshot_acquire', outcome: 'failed',
        signalAborted: outcome === 'cancelled', sessionId: 's1', requestId: 'snapshot-request', durationMs: 1_000 }), 'session view phase');
      expect(logger.warn.mock.calls.filter(([record]) => record.stage === 'snapshot_acquire' &&
        ['succeeded', 'failed', 'cancelled'].includes(record.outcome))).toHaveLength(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-source-content');
    } finally {
      gate.resolve();
      await pending;
      vi.useRealTimers();
    }
  });

  it('keeps legacy parity while transcript mode uses materialized display fields', async () => {
    const sessionId = 'sess_snapshot';
    const promptId = 'msg_snapshot_prompt';
    const workspaceId = 'wd_snapshot_012345abcdef';
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const loadParts = vi.fn(async (parts: unknown) => parts);
    const main = {
      id: 'main',
      accessor: fakeAccessor([
        [IAgentActivityView, { state: () => ({ busy: false }) }],
        [IAgentProfileService, { getModel: () => 'provider/session-model', data: () => undefined }],
        [IAgentPermissionModeService, { mode: 'yolo' }],
        [IAgentPlanService, { status: async () => ({ id: 'plan', content: '', path: '' }) }],
        [IAgentBlobService, { loadParts }],
      ]),
    };
    const approval = {
      id: 'approval-snapshot',
      kind: 'approval',
      state: 'pending',
      origin: { agentId: 'main', turnId: 7 },
      payload: {
        toolCallId: 'tc-approval',
        toolName: 'Bash',
        action: 'run',
        display: { command: 'pwd' },
      },
      createdAt: now,
    };
    const persistedAgent = {
      type: 'sub',
      parentAgentId: 'main',
      labels: { parentAgentId: 'main' },
      userLabel: 'Research API limits',
      displayName: 'explore',
      model: 'provider/metadata-model',
      thinkingEffort: 'high',
      thinkingEffortExplicit: false,
      executor: 'codex',
      executorProtocol: 'app-server',
      status: undefined as 'completed' | 'failed' | 'cancelled' | undefined,
      completedAt: undefined as number | undefined,
      toolCallCount: undefined as number | undefined,
      resultSummary: undefined as string | undefined,
    };
    const session = {
      accessor: fakeAccessor([
        [ISessionContext, { workspaceId }],
        [
          ISessionMetadata,
          {
            ready: Promise.resolve(),
            snapshot: () => structuredClone({
              id: sessionId,
              title: 'Snapshot',
              createdAt: now,
              updatedAt: now,
              archived: false,
              agents: { 'agent-1': persistedAgent },
            }),
            usage: () => undefined,
          },
        ],
        [IAgentLifecycleService, { get: () => main, list: () => [main], create: async () => main }],
        [ISessionActivityView, { state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }) }],
        [ISessionDeliveryService, { mode: () => 'reply' }],
        [
          ISessionInteractionService,
          { listPending: (kind: string) => (kind === 'approval' ? [approval] : []) },
        ],
      ]),
    };
    const handler = {
      accessor: fakeAccessor([
        [
          ISessionLifecycleService,
          { resume: async () => session, get: () => undefined },
        ],
      ]),
    };
    const core = {
      accessor: fakeAccessor([
        [
          ISessionIndex,
          {
            get: async () => ({
              id: sessionId,
              workspaceId,
              cwd: '/workspace',
              createdAt: now,
              updatedAt: now,
              archived: false,
            }),
          },
        ],
        [
          ISessionManager,
          {
            acquire: async () => ({ handle: session, dispose: () => {} }),
            get: () => session,
            list: () => [],
          },
        ],
        [IWorkspaceService, { get: async () => ({ root: '/workspace' }) }],
        [ITelemetryService, { withContext: () => ({ track2: () => {} }) }],
        [ILogService, { warn() {} }],
        [IModelPricingService, {}],
      ]),
    };
    const getTranscriptToolCallCounts = vi.fn(async () => new Map<string, number>());
    const getMaterializedTranscriptToolCallCounts = vi
      .fn<() => ReadonlyMap<string, number>>()
      .mockReturnValueOnce(new Map([['agent-1', 2]]))
      .mockReturnValue(new Map());
    const getSnapshotState = vi.fn(async (_sessionId: string, options: { captureMessages?: boolean; capture?: () => Promise<unknown> }) => {
      const captured = await options.capture?.();
      return {
      seq: 1,
      epoch: 'ep_snapshot',
      contextMessageCount: 1,
      captured,
      pendingApprovals: [{
        approval_id: 'approval-snapshot', session_id: sessionId, turn_id: 7,
        tool_call_id: 'tc-approval', tool_name: 'Bash', action: 'run',
        tool_input_display: { command: 'pwd' },
        created_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
      }],
      pendingQuestions: [],
      contextMessages: options.captureMessages === false ? [] : [
        {
          id: 'message-snapshot',
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'captured' }],
          toolCalls: [],
        },
      ],
      contextMessageTimes: [now],
      currentPromptId: promptId,
      inFlightTurn: {
        turn_id: 7,
        assistant_text: 'Hello',
        thinking_text: '',
        running_tools: [],
      },
      status: { contextTokens: 12, maxContextTokens: 128 },
      subagents: [
        {
          id: 'agent-1',
          session_id: sessionId,
          kind: 'subagent',
          description: 'task agent-1',
          model: 'provider/spawn-model',
          thinking_effort: 'low',
          thinking_effort_explicit: true,
          executor_id: 'native',
          executor_protocol: 'native',
          status: 'running',
          subagent_phase: 'working',
          parent_tool_call_id: 'tc_child_1',
          tool_call_count: 5,
          run_in_background: false,
          started_at: new Date(now).toISOString(),
          created_at: new Date(now).toISOString(),
        },
      ],
      };
    });
    const broadcaster = {
      getSnapshotState,
      getTranscriptToolCallCounts,
      getMaterializedTranscriptToolCallCounts,
    };

    let routeHandler:
      | ((
          req: {
            id: string;
            params: { session_id: string };
            query: { mode?: 'transcript' };
          },
          reply: {
            raw: {
              writableFinished: boolean;
              destroyed?: boolean;
              once(event: 'close', listener: () => void): void;
              off(event: 'close', listener: () => void): void;
            };
            send(payload: unknown): unknown;
          },
        ) => Promise<void> | void)
      | undefined;
    registerSnapshotRoutes(
      {
        get: (_path, _options, handler) => {
          routeHandler = handler;
        },
      },
      {
        core: core as never,
        broadcaster: broadcaster as never,
      },
    );

    const invoke = async (mode?: 'transcript') => {
      let payload: unknown;
      await routeHandler?.(
        { id: 'req_snapshot', params: { session_id: sessionId }, query: { mode } },
        {
          raw: {
            writableFinished: false,
            destroyed: false,
            once() {},
            off() {},
          },
          send: (value) => {
            payload = value;
          },
        },
      );
      const body = payload as { code: number; data: unknown };
      expect(body.code).toBe(0);
      return sessionSnapshotResponseSchema.parse(body.data);
    };

    const compact = await invoke('transcript');
    expect(compact.messages).toEqual({ items: [], has_more: false });
    expect(compact.session.message_count).toBe(1);
    expect(compact.in_flight_turn).toMatchObject({
      turn_id: 7,
      assistant_text: 'Hello',
      current_prompt_id: promptId,
    });
    expect(compact.session.agent_config).toMatchObject({
      model: 'provider/session-model',
      permission_mode: 'yolo',
      plan_mode: true,
    });
    expect(compact.context_tokens).toBe(12);
    expect(compact.max_context_tokens).toBe(128);
    expect(compact.pending_approvals).toEqual([
      expect.objectContaining({ approval_id: 'approval-snapshot', tool_call_id: 'tc-approval' }),
    ]);
    expect(compact.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        profile: 'explore',
        model: 'provider/metadata-model',
        thinking_effort: 'high',
        subagent_phase: 'working',
        label: 'Research API limits',
        tool_call_count: 2,
      }),
    ]);
    expect(getSnapshotState).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ captureMessages: false, capture: expect.any(Function) }));
    expect(getMaterializedTranscriptToolCallCounts).toHaveBeenCalledWith(sessionId, ['agent-1']);
    expect(getTranscriptToolCallCounts).not.toHaveBeenCalled();
    expect(loadParts).not.toHaveBeenCalled();

    const unmaterialized = await invoke('transcript');
    expect(unmaterialized.subagents?.[0]?.tool_call_count).toBeUndefined();
    expect(getTranscriptToolCallCounts).not.toHaveBeenCalled();
    expect(loadParts).not.toHaveBeenCalled();

    const legacy = await invoke();
    expect(legacy.messages.items).toHaveLength(1);
    expect(legacy).toMatchObject({
      as_of_seq: compact.as_of_seq,
      epoch: compact.epoch,
      session: compact.session,
      in_flight_turn: compact.in_flight_turn,
      pending_approvals: compact.pending_approvals,
      pending_questions: compact.pending_questions,
    });
    expect(getSnapshotState).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ captureMessages: true, capture: expect.any(Function) }));
    expect(getTranscriptToolCallCounts).not.toHaveBeenCalled();
    expect(loadParts).toHaveBeenCalledOnce();
    expect(legacy.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        subagent_phase: 'working',
        parent_agent_id: 'main',
        parent_tool_call_id: 'tc_child_1',
        label: 'Research API limits',
        tool_call_count: undefined,
        run_in_background: false,
      }),
    ]);
    expect(legacy.subagents?.[0]).toMatchObject({
      model: 'provider/metadata-model',
      thinking_effort: 'high',
      thinking_effort_explicit: false,
      executor_id: 'codex',
      executor_protocol: 'app-server',
    });

    persistedAgent.status = 'completed';
    persistedAgent.completedAt = now + 2_000;
    persistedAgent.resultSummary = 'Stored summary';
    persistedAgent.toolCallCount = 0;
    const settled = await invoke();
    expect(settled.subagents?.[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      completed_at: new Date(now + 2_000).toISOString(),
      output_preview: 'Stored summary',
      tool_call_count: 0,
    });
    getMaterializedTranscriptToolCallCounts.mockReturnValueOnce(new Map([['agent-1', 3]]));
    const measured = await invoke('transcript');
    expect(measured.subagents?.[0]?.tool_call_count).toBe(3);

    persistedAgent.completedAt = now - 1_000;
    const stale = await invoke();
    expect(stale.subagents?.[0]?.status).toBe('running');
    expect(stale.subagents?.[0]?.tool_call_count).toBeUndefined();
  });
});

describe('server-v2 GET /api/sessions/:id/snapshot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-snapshot-test-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
  }

  function emit(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    main!.accessor.get(IEventBus).publish(event);
  }

  function childWirePath(sessionId: string, agentId: string): string {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const metaScope = session.accessor.get(ISessionContext).metaScope;
    return join(home as string, metaScope, 'agents', agentId, 'wire.jsonl');
  }

  async function snapshot(sid: string, mode?: 'transcript') {
    const query = mode === undefined ? '' : '?mode=transcript';
    const res = await fetch(`${base}/api/sessions/${sid}/snapshot${query}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(0);
    return sessionSnapshotResponseSchema.parse(body.data);
  }

  it('returns a well-formed snapshot for a fresh session', async () => {
    const events = vi.spyOn(SessionEventJournal.prototype, 'append');
    try {
      const sid = await createSession();
      const snap = await snapshot(sid);
      const capturedEvents = events.mock.calls.filter(([seq, envelope]) =>
        envelope.session_id === sid && seq <= snap.as_of_seq);

      expect(snap.session.id).toBe(sid);
      expect(capturedEvents.map(([seq]) => seq)).toEqual(
        Array.from({ length: snap.as_of_seq }, (_, index) => index + 1),
      );
      expect(capturedEvents.map(([, envelope]) => envelope.type)).toEqual(expect.arrayContaining([
        'event.session.created', 'agent.created',
      ]));
      expect(capturedEvents.at(-1)?.[1].epoch).toBe(snap.epoch);
      expect(snap.epoch).toMatch(/^ep_/);
      expect(snap.messages.items).toEqual([]);
      expect(snap.in_flight_turn).toBeNull();
      expect(snap.context_tokens).toBe(0);
      expect(snap.max_context_tokens).toBeUndefined();
      expect(snap.context_breakdown).toBeUndefined();
      expect(snap.pending_approvals).toEqual([]);
      expect(snap.pending_questions).toEqual([]);
    } finally {
      events.mockRestore();
    }
  });

  it('continues legacy message previews through HTTP and rejects changed history references', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const main = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService);
    const messages: ContextMessage[] = Array.from({ length: 12 }, (_, index) => ({ role: 'user', content: [{ type: 'text', text: `Example message ${index} ${'x'.repeat(12_000)}` }], toolCalls: [] }));
    memory.append(...messages);
    await main.accessor.get(IWireService).flush();
    let preview = await snapshot(sid);
    expect(jsonBytes(preview)).toBeLessThan(24 * 1024);
    expect(preview.messages.items.length).toBeLessThanOrEqual(4);
    const originalRef = preview.contentRefs?.find((ref) => ref.path.join('.') === 'messages.items');
    expect(originalRef?.source).toEqual({ kind: 'snapshot', id: 'legacy' });
    const workspaceReads = vi.spyOn(server!.core.accessor.get(IWorkspaceService), 'get');
    const controlReads = vi.spyOn(main.accessor.get(IAgentPlanService), 'status');
    const wireReads = vi.spyOn(server!.core.accessor.get(IAppendLogStore), 'read');
    let pages = 0;
    const diagnostics = channel('kiki.session-view.timing');
    const phases: Array<Record<string, unknown>> = [];
    const collect = (record: unknown): void => { phases.push(record as Record<string, unknown>); };
    diagnostics.subscribe(collect);
    try {
      while (preview.contentRefs?.length) {
        pages++;
        const response = await fetch(`${base}/api/klient/session-view/${sid}/transcript/content`, {
          method: 'POST', headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
          body: JSON.stringify({ agentId: 'main', ref: preview.contentRefs[0] }),
        });
        const body = await response.json() as { code: number; data: ContentSegment; request_id: string };
        expect(body.code).toBe(0);
        expect(jsonBytes(body)).toBeLessThan(64 * 1024);
        expect(phases).toContainEqual(expect.objectContaining({ stage: 'snapshot_content', requestId: body.request_id,
          sessionId: sid, agentId: 'main', outcome: 'succeeded', signalAborted: false }));
        expect(phases).toContainEqual(expect.objectContaining({ stage: 'snapshot_queue', requestId: body.request_id,
          sessionId: sid, outcome: 'succeeded' }));
        preview = applyContentSegment(preview, body.data);
      }
    } finally { diagnostics.unsubscribe(collect); }
    expect(preview.messages.items.map((message) => message.content)).toEqual(messages.map((message) => message.content));
    expect(workspaceReads).not.toHaveBeenCalled();
    expect(controlReads).not.toHaveBeenCalled();
    expect(pages).toBeGreaterThan(2);
    expect(wireReads.mock.calls.filter(([scope, key]) => scope === main.accessor.get(IAgentScopeContext).scope() && key === AGENT_WIRE_RECORD_KEY)).toHaveLength(0);
    memory.append({ role: 'user', content: [{ type: 'text', text: 'Changed history' }], toolCalls: [] });
    const changed = await fetch(`${base}/api/klient/session-view/${sid}/transcript/content`, {
      method: 'POST', headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ agentId: 'main', ref: originalRef }),
    });
    expect((await changed.json() as { code: number }).code).toBe(40922);
    for (const [sessionId, agentId, ref, code] of [
      ['missing-example-session', 'main', originalRef, 40401],
      [sid, 'example-other-agent', originalRef, 40922],
      [sid, 'main', { ...originalRef, source: { kind: 'snapshot', id: 'example-other-source' } }, 40922],
    ] as const) {
      const invalid = await fetch(`${base}/api/klient/session-view/${sessionId}/transcript/content`, {
        method: 'POST', headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ agentId, ref }),
      });
      expect((await invalid.json() as { code: number }).code).toBe(code);
    }
  });

  it('shares a captured history read and cancels it when the last waiter leaves', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const main = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService).get('main')!;
    const messages: ContextMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Shared snapshot history' }], toolCalls: [] }];
    main.accessor.get(IAgentContextMemoryService).append(...messages);
    await main.accessor.get(IWireService).flush();
    const logs = server!.core.accessor.get(IAppendLogStore);
    const raw = logs.read.bind(logs);
    let gate = deferred();
    let entered = deferred();
    const signals: Array<AbortSignal | undefined> = [];
    let settled = 0;
    const read = vi.spyOn(logs, 'read').mockImplementation((scope, key, options) => {
      if (scope !== main.accessor.get(IAgentScopeContext).scope() || key !== AGENT_WIRE_RECORD_KEY) return raw(scope, key, options);
      signals.push(options?.signal);
      const hold = gate;
      return (async function* () {
        entered.resolve();
        try {
          await hold.promise;
          options?.signal?.throwIfAborted();
          yield* raw(scope, key, options);
        } finally { settled++; }
      })();
    });
    const one = new AbortController();
    const two = new AbortController();
    const first = messageHistory.captureContextMessageHistory(server!.core, main, messages, one.signal);
    void first.catch(() => {});
    try {
      await entered.promise;
      const second = messageHistory.captureContextMessageHistory(server!.core, main, messages, two.signal);
      for (let tick = 0; tick < 6; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
      one.abort();
      await expect(first).rejects.toThrow();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      gate.resolve();
      expect((await second).messages).toEqual(messages);
      logs.append(main.accessor.get(IAgentScopeContext).scope(), AGENT_WIRE_RECORD_KEY, { type: 'example.unrelated', time: Date.now() });
      await logs.flush();
      gate = deferred();
      entered = deferred();
      const final = new AbortController();
      const pending = messageHistory.captureContextMessageHistory(server!.core, main, messages, final.signal);
      void pending.catch(() => {});
      await entered.promise;
      final.abort();
      await expect(pending).rejects.toThrow();
      expect(signals[1]?.aborted).toBe(true);
      gate.resolve();
      await vi.waitFor(() => expect(settled).toBe(2));
    } finally {
      gate.resolve();
      read.mockRestore();
    }
  });

  it.each([false, true])('continues only the snapshot logical context after compaction (cold=%s)', async (cold) => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const main = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService);
    memory.append(...Array.from({ length: 14 }, (_, index): ContextMessage => ({
      role: 'user', content: [{ type: 'text', text: `Message ${index}` }], toolCalls: [],
    })));
    memory.applyCompaction({ summary: 'Earlier context', compactedCount: 6, tokensBefore: 100, tokensAfter: 40 });
    const expected = memory.get().slice(-100).map((message) => message.content);
    await main.accessor.get(IWireService).flush();
    if (cold) await closeSessionById(server!.core.accessor, sid);
    let preview = await snapshot(sid);
    let pages = 0;
    while (preview.contentRefs?.length) {
      const response = await fetch(`${base}/api/klient/session-view/${sid}/transcript/content`, {
        method: 'POST', headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ agentId: 'main', ref: preview.contentRefs[0] }),
      });
      const body = await response.json() as { code: number; data: ContentSegment };
      expect(body.code).toBe(0);
      preview = applyContentSegment(preview, body.data);
      expect(++pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(0);
    expect(preview.messages.items.map((message) => message.content)).toEqual(expected);
    if (cold) expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();
  });

  it.each([
    { label: 'missing', content: undefined, count: undefined },
    {
      label: 'corrupt',
      content: ['not-json', '{}'].join(String.fromCodePoint(10)) + String.fromCodePoint(10),
      count: undefined,
    },
    { label: 'empty', content: '', count: undefined },
  ] as const)('[STAT-R3] compact snapshot keeps an unproven $label child count unknown', async ({
    label,
    content,
    count,
  }) => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const childId = `child-snapshot-r3-${label}`;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: childId });
    const wirePath = childWirePath(sid, childId);
    const originalWire = await readFile(wirePath);
    try {
    if (content === undefined) await rm(wirePath, { force: true });
    else await writeFile(wirePath, content, 'utf8');
    emit(sid, {
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: 'snapshot-child',
      parentAgentId: 'main',
      parentToolCallId: 'tc-snapshot-r3',
      description: `task ${childId}`,
      userLabel: `task ${childId}`,
      runInBackground: false,
    } as unknown as Event2<any>);

    const snap = await snapshot(sid, 'transcript');
    const child = (snap.subagents ?? []).find((subagent) => subagent.id === childId);
    expect(child).toBeDefined();
    expect(child?.tool_call_count).toBe(count);
    } finally {
      await writeFile(wirePath, originalWire);
    }
  });

  it('keeps the legacy snapshot readable and skips history work in transcript mode', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const main = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentTaskService).resumeRestoration?.();
    const compactRes = await fetch(`${base}/api/sessions/${sid}/snapshot?mode=transcript`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const compactBody = (await compactRes.json()) as { code: number; data: unknown };
    expect(compactBody.code).toBe(0);
    const compact = sessionSnapshotResponseSchema.parse(compactBody.data);
    expect(compact.messages).toEqual({ items: [], has_more: false });
    expect(compact.session.id).toBe(sid);

    const legacy = await snapshot(sid);
    expect(legacy.as_of_seq).toBe(compact.as_of_seq);
    expect(legacy.epoch).toBe(compact.epoch);
    expect(legacy.session).toEqual(compact.session);
    expect(legacy.messages.items).toEqual([]);
  });

  it('matches the messages route projection for captured message identity and time', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    const main = session?.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    main.accessor.get(IAgentContextMemoryService).append({
      id: 'msg_snapshot_parity',
      role: 'user',
      content: [{ type: 'text', text: 'timestamp parity' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    const snap = await snapshot(sid);
    const res = await fetch(`${base}/api/sessions/${sid}/messages?page_size=100`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as {
      code: number;
      data: { items: Array<{ id: string; content: unknown; created_at: string }> };
    };
    expect(body.code).toBe(0);
    const snapshotMessage = snap.messages.items.find((message) => message.id === 'msg_snapshot_parity');
    const routeMessage = body.data.items.find((message) => message.id === 'msg_snapshot_parity');
    expect(snapshotMessage).toBeDefined();
    expect(routeMessage).toBeDefined();
    expect(snapshotMessage).toMatchObject({
      id: routeMessage?.id,
      content: routeMessage?.content,
      created_at: routeMessage?.created_at,
    });
  });

  it('keeps frozen messages and volatile ownership while append-log read crosses the barrier', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    const main = session?.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    const context = main.accessor.get(IAgentContextMemoryService);
    const stepId = 'step-capture-boundary';
    const answer = 'future durable answer';

    emit(sid, {
      type: 'turn.started',
      turnId: 11,
      origin: { kind: 'user' },
    } as unknown as Event2<any>);
    emit(sid, {
      type: 'turn.step.started',
      turnId: 11,
      step: 1,
      stepId,
    } as unknown as Event2<any>);
    context.appendLoopEvent({ type: 'step.begin', uuid: stepId, turnId: '11', step: 1 });
    emit(sid, {
      type: 'assistant.delta',
      turnId: 11,
      step: 1,
      stepId,
      delta: answer,
    } as unknown as Event2<any>);

    const boundary = await snapshot(sid);
    expect(boundary.in_flight_turn).toMatchObject({
      turn_id: 11,
      step: 1,
      step_id: stepId,
      assistant_text: answer,
    });

    const appendLog = server!.core.accessor.get(IAppendLogStore);
    const mainScope = main.accessor.get(IAgentScopeContext).scope();
    appendLog.append(mainScope, AGENT_WIRE_RECORD_KEY, { type: 'example.unrelated', time: Date.now() });
    await appendLog.flush(mainScope, AGENT_WIRE_RECORD_KEY);
    const readEntered = deferred();
    const releaseRead = deferred();
    const futureAppended = deferred();
    const originalRead = appendLog.read.bind(appendLog) as typeof appendLog.read;
    const originalAppend = appendLog.append.bind(appendLog) as typeof appendLog.append;
    let shouldPause = false;
    let latestSeq = boundary.as_of_seq;
    let capturedSeq = boundary.as_of_seq;
    const readSeq = Object.getOwnPropertyDescriptor(SessionEventJournal.prototype, 'seq')!.get!;
    const seqSpy = vi.spyOn(SessionEventJournal.prototype, 'seq', 'get').mockImplementation(function (this: SessionEventJournal) {
      const seq = readSeq.call(this) as number;
      if (this.epoch === boundary.epoch) latestSeq = seq;
      return seq;
    });
    const captureHistory = messageHistory.captureContextMessageHistory;
    const historySpy = vi.spyOn(messageHistory, 'captureContextMessageHistory').mockImplementation((...args) => {
      shouldPause = true;
      return captureHistory(...args);
    });
    const readSpy = vi.spyOn(appendLog, 'read').mockImplementation(<R>(scope: string, key: string) => {
      const source = originalRead<R>(scope, key);
      return (async function* (): AsyncIterableIterator<R> {
        if (shouldPause && scope === mainScope && key === AGENT_WIRE_RECORD_KEY) {
          shouldPause = false;
          capturedSeq = latestSeq;
          readEntered.resolve();
          await releaseRead.promise;
        }
        yield* source;
      })();
    });
    const appendSpy = vi
      .spyOn(appendLog, 'append')
      .mockImplementation(<R>(
        scope: string,
        key: string,
        record: R,
        options?: { readonly onError?: (error: unknown) => void },
      ) => {
        originalAppend(scope, key, record, options);
        const candidate = record as { type?: unknown; event?: { uuid?: unknown } };
        if (
          scope === mainScope &&
          key === AGENT_WIRE_RECORD_KEY &&
          candidate.type === 'context.append_loop_event' &&
          candidate.event?.uuid === 'part-capture-boundary'
        ) {
          futureAppended.resolve();
        }
      });
    const originalJournalAppend = SessionEventJournal.prototype.append;
    let advancedSeq: number | undefined;
    const journalSpy = vi
      .spyOn(SessionEventJournal.prototype, 'append')
      .mockImplementation(function (
        this: SessionEventJournal,
        seq: number,
        envelope: EventEnvelope,
      ): void {
        originalJournalAppend.call(this, seq, envelope);
        if (envelope.session_id === sid && envelope.type === 'turn.step.completed') {
          advancedSeq = seq;
        }
      });

    const currentPromise = snapshot(sid);
    await readEntered.promise;
    context.appendLoopEvent({
      type: 'content.part',
      uuid: 'part-capture-boundary',
      turnId: '11',
      step: 1,
      stepUuid: stepId,
      part: { type: 'text', text: answer },
    });
    await futureAppended.promise;
    emit(sid, {
      type: 'turn.step.completed',
      turnId: 11,
      step: 1,
      stepId,
    } as unknown as Event2<any>);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const seqBeforeReadRelease = advancedSeq;
    releaseRead.resolve();
    const current = await currentPromise;
    journalSpy.mockRestore();
    appendSpy.mockRestore();
    readSpy.mockRestore();
    historySpy.mockRestore();
    seqSpy.mockRestore();

    expect(capturedSeq).toBeGreaterThanOrEqual(boundary.as_of_seq);
    expect(seqBeforeReadRelease).toBeGreaterThan(capturedSeq);
    expect(current.as_of_seq).toBe(capturedSeq);
    expect(current.messages).toEqual(boundary.messages);
    expect(current.in_flight_turn).toEqual(boundary.in_flight_turn);

    const next = await snapshot(sid);
    expect(
      next.messages.items
        .flatMap((message) => message.content)
        .some((part) => part.type === 'text' && part.text === answer),
    ).toBe(true);
    expect(next.in_flight_turn).toMatchObject({
      turn_id: 11,
      step: 1,
      step_id: stepId,
      assistant_text: '',
    });
    const messageResponse = await fetch(`${base}/api/sessions/${sid}/messages?page_size=100`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const messageBody = (await messageResponse.json()) as {
      code: number;
      data: {
        items: Array<{
          id: string;
          content: Array<{ type: string; text?: string }>;
          created_at: string;
        }>;
      };
    };
    expect(messageBody.code).toBe(0);
    const snapshotMessage = next.messages.items.find((message) =>
      message.content.some((part) => part.type === 'text' && part.text === answer),
    );
    const routeMessage = messageBody.data.items.find((message) =>
      message.content.some((part) => part.type === 'text' && part.text === answer),
    );
    expect(snapshotMessage).toMatchObject({
      id: routeMessage?.id,
      content: routeMessage?.content,
      created_at: routeMessage?.created_at,
    });
  });

  it('projects live usage into the snapshot session', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    const main = session?.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    main.accessor.get(IAgentUsageService).record('example-model', {
      inputOther: 13,
      output: 8,
      inputCacheRead: 5,
      inputCacheCreation: 2,
    });
    emit(sid, {
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    } as unknown as Event2);
    emit(sid, {
      type: 'turn.ended',
      turnId: 0,
      reason: 'completed',
    } as unknown as Event2);

    const snap = await snapshot(sid);
    expect(snap.session.usage).toMatchObject({
      input_tokens: 13,
      output_tokens: 8,
      cache_read_tokens: 5,
      cache_creation_tokens: 2,
      total_cost_usd: 0,
      turn_count: 1,
    });
  });

  it('includes subagent usage in the snapshot session aggregate', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error('expected a live session');
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const main = lifecycle.get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    const child = await lifecycle.create({ agentId: 'worker-1' });
    main.accessor.get(IAgentUsageService).record('example-model', {
      inputOther: 13,
      output: 8,
      inputCacheRead: 5,
      inputCacheCreation: 2,
    });
    child.accessor.get(IAgentUsageService).record('example-model', {
      inputOther: 7,
      output: 3,
      inputCacheRead: 4,
      inputCacheCreation: 6,
    });
    emit(sid, {
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    } as unknown as Event2);
    emit(sid, {
      type: 'turn.ended',
      turnId: 0,
      reason: 'completed',
    } as unknown as Event2);
    child.accessor.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 4,
      origin: { kind: 'user' },
    } as unknown as Event2);
    child.accessor.get(IEventBus).publish({
      type: 'turn.ended',
      turnId: 4,
      reason: 'completed',
    } as unknown as Event2);

    const snap = await snapshot(sid);
    expect(snap.session.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 11,
      cache_read_tokens: 9,
      cache_creation_tokens: 8,
      total_cost_usd: 0,
      turn_count: 1,
    });
  });

  it('reflects the durable watermark and in-flight turn after events', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);

    emit(sid, {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event2<any>);
    emit(sid, {
      type: 'assistant.delta',
      turnId: 1,
      delta: 'Hello',
    } as unknown as Event2<any>);

    const snap = await snapshot(sid);
    expect(snap.as_of_seq).toBeGreaterThanOrEqual(2);
    expect(snap.in_flight_turn).toMatchObject({
      turn_id: 1,
      assistant_text: 'Hello',
    });
  });

  it('transfers assistant ownership after content.part before turn.ended', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    const main = session?.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    const context = main.accessor.get(IAgentContextMemoryService);
    const stepId = 'step-owned-1';

    emit(sid, {
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event2<any>);
    emit(sid, {
      type: 'turn.step.started',
      turnId: 1,
      step: 1,
      stepId,
    } as unknown as Event2<any>);
    context.appendLoopEvent({ type: 'step.begin', uuid: stepId, turnId: '1', step: 1 });
    emit(sid, {
      type: 'assistant.delta',
      turnId: 1,
      step: 1,
      stepId,
      delta: 'committed answer',
    } as unknown as Event2<any>);
    context.appendLoopEvent({
      type: 'content.part',
      uuid: 'part-owned-1',
      turnId: '1',
      step: 1,
      stepUuid: stepId,
      part: { type: 'text', text: 'committed answer' },
    });

    const snap = await snapshot(sid);
    const assistantText = snap.messages.items
      .filter((message) => message.role === 'assistant')
      .flatMap((message) =>
        message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
      );
    expect(assistantText).toContain('committed answer');
    expect(snap.in_flight_turn).toMatchObject({
      step: 1,
      step_id: stepId,
      assistant_text: '',
    });
  });

  it('keeps a running tool overlay without retaining committed assistant text', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    const main = session?.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('expected a live main agent');
    const context = main.accessor.get(IAgentContextMemoryService);
    const stepId = 'step-tool-1';

    emit(sid, {
      type: 'turn.started',
      turnId: 2,
      origin: { kind: 'user' },
    } as unknown as Event2<any>);
    emit(sid, {
      type: 'turn.step.started',
      turnId: 2,
      step: 1,
      stepId,
    } as unknown as Event2<any>);
    context.appendLoopEvent({ type: 'step.begin', uuid: stepId, turnId: '2', step: 1 });
    emit(sid, {
      type: 'assistant.delta',
      turnId: 2,
      step: 1,
      stepId,
      delta: 'running a tool',
    } as unknown as Event2<any>);
    context.appendLoopEvent({
      type: 'content.part',
      uuid: 'part-tool-1',
      turnId: '2',
      step: 1,
      stepUuid: stepId,
      part: { type: 'text', text: 'running a tool' },
    });
    emit(sid, {
      type: 'tool.call.started',
      turnId: 2,
      toolCallId: 'call-tool-1',
      name: 'Bash',
      args: { command: 'sleep 5' },
    } as unknown as Event2<any>);
    context.appendLoopEvent({
      type: 'tool.call',
      uuid: 'tool-owned-1',
      turnId: '2',
      step: 1,
      stepUuid: stepId,
      toolCallId: 'call-tool-1',
      name: 'Bash',
      args: { command: 'sleep 5' },
    });

    const running = await snapshot(sid);
    expect(running.in_flight_turn?.assistant_text).toBe('');
    expect(running.in_flight_turn?.running_tools).toEqual([
      expect.objectContaining({ tool_call_id: 'call-tool-1', name: 'Bash' }),
    ]);
    expect(
      running.messages.items
        .flatMap((message) => message.content)
        .some((part) => part.type === 'tool_use' && part.tool_call_id === 'call-tool-1'),
    ).toBe(true);

    emit(sid, {
      type: 'tool.result',
      turnId: 2,
      toolCallId: 'call-tool-1',
      output: 'done',
    } as unknown as Event2<any>);
    context.appendLoopEvent({
      type: 'tool.result',
      parentUuid: 'tool-owned-1',
      toolCallId: 'call-tool-1',
      result: { output: 'done' },
    });

    const completed = await snapshot(sid);
    expect(completed.in_flight_turn?.running_tools).toEqual([]);
    expect(
      completed.messages.items
        .flatMap((message) => message.content)
        .some((part) => part.type === 'tool_result' && part.tool_call_id === 'call-tool-1'),
    ).toBe(true);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${base}/api/sessions/sess_does_not_exist/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).not.toBe(0);
  });

  it('loads a cold (not live) session instead of 404', async () => {
    const sid = await createSession();

    await server!.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
  });

  it('returns the persisted transcript for a cold session', async () => {
    const sid = await createSession();
    const live = getLiveSessionById(server!.core.accessor, sid);
    if (live === undefined) throw new Error(`session ${sid} not found`);
    const metaScope = live.accessor.get(ISessionContext).metaScope;

    const wireDir = join(home as string, metaScope, 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const records = [
      { type: 'metadata', protocol_version: '1.4', created_at: Date.now() },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello-from-disk' }], toolCalls: [] },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi-from-disk' }],
          toolCalls: [],
        },
      },
    ];
    await writeFile(
      join(wireDir, 'wire.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );

    await server!.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();

    const workers = server!.core.accessor.get(ICpuWorkerService);
    const readSpy = vi.spyOn(workers, 'request');
    const compact = await snapshot(sid, 'transcript');
    expect(readSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'wire.context' }), expect.any(Object));
    readSpy.mockClear();
    const compactWarm = await snapshot(sid, 'transcript');
    expect(readSpy).not.toHaveBeenCalled();
    expect(compactWarm.messages.items).toEqual([]);
    const snap = await snapshot(sid);
    expect(readSpy).not.toHaveBeenCalled();
    expect(snap.session.id).toBe(sid);
    expect(snap.session.message_count).toBe(2);
    expect(snap.messages.items).toHaveLength(2);
    expect(compact.session.message_count).toBe(2);
    expect(compact.messages.items).toEqual([]);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('hello-from-disk');
    expect((snap.messages.items[1]!.content[0] as { text: string }).text).toBe('hi-from-disk');
    expect(snap.epoch).toMatch(/^ep_/);
    await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n${JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'changed-on-disk' }], toolCalls: [] },
    })}\n`, 'utf-8');
    readSpy.mockClear();
    const changed = await snapshot(sid, 'transcript');
    expect(readSpy).toHaveBeenCalled();
    expect(changed.session.message_count).toBe(3);
    expect(changed.messages.items).toEqual([]);
    const summary = await server!.core.accessor.get(ISessionIndex).get(sid);
    if (summary === undefined) throw new Error(`session ${sid} missing from the index`);
    const aborted = new AbortController();
    aborted.abort();
    readSpy.mockClear();
    await expect(readColdMainWireProjection(server!.core, summary.workspaceId, sid, aborted.signal)).rejects.toThrow(/abort/i);
    expect(readSpy).not.toHaveBeenCalled();
    await writeFile(join(wireDir, 'wire.jsonl'), `${JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_200_000) }], toolCalls: [] },
    })}\n`, 'utf-8');
    readSpy.mockClear();
    const heavy = await snapshot(sid, 'transcript');
    expect(heavy.session.message_count).toBe(1);
    expect(heavy.messages.items).toEqual([]);
    readSpy.mockClear();
    const heavyAgain = await snapshot(sid, 'transcript');
    expect(readSpy).toHaveBeenCalled();
    expect(heavyAgain.session.message_count).toBe(1);
    expect(heavyAgain.messages.items).toEqual([]);
    readSpy.mockRestore();
  });

  it('retains cold identity-only subagent relations without presenting them as active', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const sub = await session.accessor.get(IAgentLifecycleService).create({
      agentId: 'agent-1',
      delegator: { kind: 'agent', agentId: 'main' },
      labels: { parentAgentId: 'main' },
      userLabel: 'Research API limits',
    });
    sub.accessor.get(IAgentContextMemoryService).append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'inspect usage accounting' }],
        toolCalls: [],
      } as ContextMessage,
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: 'call-read-1',
            name: 'Read',
            arguments: '{"path":"README.md"}',
          },
        ],
      } as ContextMessage,
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        toolCallId: 'call-read-1',
      } as ContextMessage,
    );
    await sub.accessor.get(IWireService).flush();
    await session.accessor.get(ISessionMetadata).registerAgent('agent-1', {
      type: 'sub',
      parentAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' },
      labels: { parentAgentId: 'main' },
      displayName: 'explore',
      userLabel: 'Research API limits',
      model: 'provider/subagent-model',
      thinkingEffort: 'high',
    });

    await server!.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();

    const snap = await snapshot(sid);
    expect(snap.subagents).toEqual([expect.objectContaining({
      id: 'agent-1', label: 'Research API limits', profile: 'explore',
      activity_status: 'unknown', status_source: 'metadata', live: false,
    })]);
  });

  it('serves a v1-layout session (ISO timestamps, no id field) without crashing', async () => {
    const sid = await createSession();
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const metaScope = session.accessor.get(ISessionContext).metaScope;

    await server!.close();
    server = undefined;
    const statePath = join(home as string, metaScope, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
        custom: { source: 'v1' },
      }),
    );

    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await resumeSessionById(server!.core.accessor, sid);
    if (resumed === undefined) throw new Error(`session ${sid} failed to resume`);
    const main = await resumed.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const context = main.accessor.get(IAgentContextMemoryService);
    context.append({ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] });
    context.append({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] });

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
    expect(snap.session.title).toBe('v1 session');
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
    expect(snap.messages.items.length).toBeGreaterThan(0);
    for (const message of snap.messages.items) {
      expect(Number.isNaN(Date.parse(message.created_at))).toBe(false);
    }
  });
});

describe('legacy snapshot message tail projection', () => {
  const sessionId = 'sess_tail';
  const workspaceId = 'wd_tail_012345abcdef';
  const createdAt = Date.parse('2026-02-01T00:00:00.000Z');

  function projectedCreatedAt(
    times: readonly (number | undefined)[],
    count: number,
  ): string[] {
    const out: string[] = [];
    let previousMs = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      const baseMs = times[index] ?? createdAt + index;
      const ms = Math.max(previousMs + 1, baseMs);
      previousMs = ms;
      out.push(new Date(ms).toISOString());
    }
    return out;
  }

  async function assembleWithHistory(
    size: number,
    times: readonly (number | undefined)[],
    mode?: 'transcript',
  ): Promise<{
    messages: { items: Array<{ id: string; created_at: string; content: unknown }>; has_more: boolean };
    messageCount: number;
    asOfSeq: number;
    epoch: string;
    loadParts: ReturnType<typeof vi.fn>;
    snapshotLoadPartsCalls: number;
  }> {
    const loadParts = vi.fn(async (parts: unknown) => parts);
    const main = {
      id: 'main',
      accessor: fakeAccessor([
        [IAgentActivityView, { state: () => ({ busy: false }) }],
        [IAgentProfileService, { getModel: () => 'provider/tail-model', data: () => undefined }],
        [IAgentPermissionModeService, { mode: 'yolo' }],
        [IAgentPlanService, { status: async () => null }],
        [IAgentBlobService, { loadParts }],
      ]),
    };
    const session = {
      accessor: fakeAccessor([
        [ISessionContext, { workspaceId }],
        [
          ISessionMetadata,
          {
            ready: Promise.resolve(),
            snapshot: () => ({
              id: sessionId,
              title: 'Tail',
              createdAt,
              updatedAt: createdAt,
              archived: false,
              agents: {},
            }),
            usage: () => undefined,
          },
        ],
        [IAgentLifecycleService, { get: () => main, list: () => [main], create: async () => main }],
        [ISessionInteractionService, { listPending: () => [] }],
        [ISessionActivityView, { state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }) }],
        [ISessionDeliveryService, { mode: () => 'reply' }],
      ]),
    };
    const core = {
      accessor: fakeAccessor([
        [
          ISessionManager,
          { acquire: async () => ({ handle: session, dispose: () => {} }), get: () => session, list: () => [] },
        ],
        [IWorkspaceService, { get: async () => ({ root: '/workspace' }) }],
        [ILogService, { warn() {} }],
        [IModelPricingService, {}],
      ]),
    };
    const contextMessages = Array.from({ length: size }, (_, index) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `m${index}` }],
      toolCalls: [],
    }));
    const broadcaster = {
      getSnapshotState: async (
        _sessionId: string,
        options: { captureMessages?: boolean; capture?: () => Promise<unknown> },
      ) => ({
        seq: 7,
        epoch: 'ep_tail',
        contextMessageCount: size,
        captured: await options.capture?.(),
        pendingApprovals: [],
        pendingQuestions: [],
        contextMessages: options.captureMessages === false ? [] : contextMessages,
        contextMessageTimes: options.captureMessages === false ? [] : [...times],
        currentPromptId: undefined,
        inFlightTurn: null,
        status: undefined,
        subagents: [],
      }),
      getTranscriptToolCallCounts: async () => new Map<string, number>(),
      getMaterializedTranscriptToolCallCounts: () => new Map<string, number>(),
    };
    let data = await assembleSnapshot(core as never, broadcaster as never, sessionId, mode);
    const snapshotLoadPartsCalls = loadParts.mock.calls.length;
    expect(jsonBytes(data)).toBeLessThan(24 * 1024);
    expect(data.messages.items.length).toBeLessThanOrEqual(4);
    if (data.contentRefs?.length) {
      const source = await assembleBrowseSnapshotSource(core as never, broadcaster as never, sessionId, 'legacy');
      expect(loadParts.mock.calls.length - snapshotLoadPartsCalls).toBe(Math.min(size, 100));
      while (data.contentRefs?.length) data = applyContentSegment(data, readContentSegment(source, data.contentRefs[0]!));
    }
    return {
      snapshotLoadPartsCalls,
      messages: data.messages as {
        items: Array<{ id: string; created_at: string; content: unknown }>;
        has_more: boolean;
      },
      messageCount: data.session.message_count,
      asOfSeq: data.as_of_seq,
      epoch: data.epoch,
      loadParts,
    };
  }

  it.each([0, 1, 99, 100, 101, 10_000])(
    'projects only the newest 100 messages when the captured history has %i messages',
    async (size) => {
      const times = Array.from({ length: size }, (_, index) => createdAt + index);
      const { messages, messageCount, asOfSeq, epoch, snapshotLoadPartsCalls } = await assembleWithHistory(size, times);

      const expectedCount = Math.min(size, 100);
      expect(messageCount).toBe(size);
      expect(messages.items).toHaveLength(expectedCount);
      expect(messages.has_more).toBe(size > 100);
      expect(asOfSeq).toBe(7);
      expect(epoch).toBe('ep_tail');
      expect(snapshotLoadPartsCalls).toBe(expectedCount);

      const expectedCreatedAt = projectedCreatedAt(times, size).slice(-expectedCount);
      expect(messages.items.map((message) => message.created_at)).toEqual(expectedCreatedAt);
      if (size > 0) {
        const firstIndex = Math.max(0, size - 100);
        expect(messages.items[0]?.id).toBe(
          `msg_${sessionId}_${String(firstIndex).padStart(6, '0')}`,
        );
        expect(messages.items.at(-1)?.content).toEqual([{ type: 'text', text: `m${size - 1}` }]);
      }
    },
  );

  it('reports the full history count in transcript mode without hydrating message items', async () => {
    const { messages, messageCount, loadParts } = await assembleWithHistory(101, [], 'transcript');
    expect(messageCount).toBe(101);
    expect(messages).toEqual({ items: [], has_more: false });
    expect(loadParts).not.toHaveBeenCalled();
  });

  it('keeps absolute ids and the monotonic clamp when prefix times are unordered', async () => {
    const size = 105;
    const times = Array.from({ length: size }, (_, index) =>
      index < 5 ? 60_000 - index * 10_000 : createdAt + index,
    );
    const { messages, snapshotLoadPartsCalls } = await assembleWithHistory(size, times);

    expect(messages.has_more).toBe(true);
    expect(snapshotLoadPartsCalls).toBe(100);
    const expectedCreatedAt = projectedCreatedAt(times, size).slice(5);
    expect(messages.items.map((message) => message.created_at)).toEqual(expectedCreatedAt);
    for (let index = 1; index < messages.items.length; index += 1) {
      expect(Date.parse(messages.items[index]!.created_at)).toBeGreaterThan(
        Date.parse(messages.items[index - 1]!.created_at),
      );
    }
    expect(messages.items[0]?.id).toBe(`msg_${sessionId}_000005`);
    expect(messages.items.at(-1)?.content).toEqual([{ type: 'text', text: 'm104' }]);
  });
});

describe('server-v2 session operation lease', () => {
  const EVICTION_ENV = 'KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION';
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-session-lease-'));
    await writeFile(
      join(home, 'config.toml'),
      ['[session_residency]', 'idle_ttl_ms = 0', 'min_idle_ms = 0', 'sweep_interval_ms = 300000', ''].join('\n'),
      'utf-8',
    );
    process.env[EVICTION_ENV] = 'true';
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    delete process.env[EVICTION_ENV];
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agents = session.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
  }

  function managerOf(): ISessionManager {
    return server!.core.accessor.get(ISessionManager);
  }

  function spyLeases(manager: ISessionManager): { acquires: string[]; disposals: string[] } {
    const acquires: string[] = [];
    const disposals: string[] = [];
    const acquire = manager.acquire!.bind(manager);
    vi.spyOn(manager, 'acquire').mockImplementation(async (sessionId, reason, options) => {
      acquires.push(`${sessionId}:${reason}`);
      const lease = await acquire(sessionId, reason, options);
      if (lease === undefined) return undefined;
      return {
        handle: lease.handle,
        dispose: async () => {
          disposals.push(sessionId);
          await lease.dispose();
        },
      };
    });
    return { acquires, disposals };
  }

  function pauseFirstIndexRead(sessionId: string): { reached: Promise<void>; release(): void } {
    const index = server!.core.accessor.get(ISessionIndex);
    const get = index.get.bind(index);
    const reached = deferred();
    const gate = deferred();
    let first = true;
    vi.spyOn(index, 'get').mockImplementation(async (id) => {
      if (id === sessionId && first) {
        first = false;
        reached.resolve();
        await gate.promise;
      }
      return get(id);
    });
    return { reached: reached.promise, release: gate.resolve };
  }

  function enqueueInteraction(sessionId: string, kind: 'questions' | 'approvals'): string {
    const session = getLiveSessionById(server!.core.accessor, sessionId)!;
    if (kind === 'questions') {
      return session.accessor.get(ISessionQuestionService).enqueue({
        id: 'q-lease-race', questions: [{ question: 'Choose', options: [{ label: 'Yes' }] }],
      }).id;
    }
    const interaction = session.accessor.get(ISessionInteractionService);
    interaction.acquireConsumer('race-test');
    return session.accessor.get(ISessionApprovalService).enqueue({
      id: 'approval-lease-race', toolCallId: 'tc-lease-race', toolName: 'Bash', action: 'run',
      display: { kind: 'command', command: 'pwd' },
    }).id;
  }

  it('keeps the session pinned while the snapshot route awaits and releases it in finally', async () => {
    const sessionId = await createSession();
    await ensureMainAgent(sessionId);
    const manager = managerOf();
    const gate = deferred();
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const broadcaster = {
      getSnapshotState: async (
        _sessionId: string,
        options: { captureMessages?: boolean; capture?: () => Promise<unknown> },
      ) => {
        const captured = await options.capture?.();
        reached();
        await gate.promise;
        return {
          seq: 0,
          epoch: 'ep_lease',
          contextMessageCount: 0,
          captured,
          pendingApprovals: [],
          pendingQuestions: [],
          contextMessages: [],
          contextMessageTimes: [],
          currentPromptId: undefined,
          inFlightTurn: null,
          status: undefined,
          subagents: [],
        };
      },
      getTranscriptToolCallCounts: async () => new Map<string, number>(),
      getMaterializedTranscriptToolCallCounts: () => new Map<string, number>(),
    };

    const outcome = assembleSnapshot(server!.core, broadcaster as never, sessionId, 'transcript').then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await reachedPromise;

    await expect(manager.evictIfIdle!(sessionId)).resolves.toBe(false);
    expect(manager.residencyReport!().pinnedSessions).toBe(1);
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeDefined();

    gate.resolve();
    const result = await outcome;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.session.id).toBe(sessionId);

    await expect(manager.evictIfIdle!(sessionId)).resolves.toBe(true);
    expect(manager.residencyReport!().pinnedSessions).toBe(0);
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
  });

  it('releases the operation lease once the snapshot response is served', async () => {
    const sessionId = await createSession();
    await ensureMainAgent(sessionId);
    const manager = managerOf();
    const leases = spyLeases(manager);

    const res = await fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: { session: { id: string } } };
    expect(body.code).toBe(0);
    expect(body.data.session.id).toBe(sessionId);
    expect(leases.acquires).toEqual([`${sessionId}:operation`]);
    expect(leases.disposals).toEqual([sessionId]);
    expect(manager.residencyReport!().pinnedSessions).toBe(0);

    await expect(manager.evictIfIdle!(sessionId)).resolves.toBe(true);
  });

  it('releases the session operation when snapshot assembly rejects', async () => {
    const sessionId = await createSession();
    await ensureMainAgent(sessionId);
    const main = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentTaskService).resumeRestoration?.();
    const manager = managerOf();
    const leases = spyLeases(manager);
    const broadcaster = {
      getSnapshotState: async () => { throw new Error('capture failed'); },
    };
    await expect(assembleSnapshot(server!.core, broadcaster as never, sessionId, 'transcript'))
      .rejects.toThrow('capture failed');
    expect(leases.acquires).toEqual([`${sessionId}:operation`]);
    expect(leases.disposals).toEqual([sessionId]);
    expect(manager.residencyReport!().pinnedSessions).toBe(0);
    expect(await manager.evictIfIdle!(sessionId)).toBe(true);
  });

  it('pins a message read through hydration and releases the pin after serving it', async () => {
    const sessionId = await createSession();
    await ensureMainAgent(sessionId);
    const manager = managerOf();
    const agent = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    const wire = agent.accessor.get(IWireService);
    const flush = wire.flush.bind(wire);
    const gate = deferred();
    const reached = deferred();
    vi.spyOn(wire, 'flush').mockImplementation(async () => {
      if (manager.residencyReport!().pinnedSessions > 0) {
        reached.resolve();
        await gate.promise;
      }
      return flush();
    });
    const response = fetch(`${base}/api/sessions/${sessionId}/messages`, {
      headers: authHeaders(server as RunningServer),
    } as never).then(async (res) => (await res.json()) as { code: number; data?: { items: unknown[] } });
    try {
      await Promise.race([reached.promise, response.then(() => { throw new Error('message read finished before the barrier'); })]);
      expect(manager.residencyReport!().pinnedSessions).toBe(1);
      expect(await manager.evictIfIdle!(sessionId)).toBe(false);
    } finally {
      gate.resolve();
    }
    const body = await response;
    expect(body.code).toBe(0);
    expect(body.data?.items).toEqual([]);
    expect(manager.residencyReport!().pinnedSessions).toBe(0);
    expect(await manager.evictIfIdle!(sessionId)).toBe(true);
  });

  it('pins an approval write from resume through decision and releases it afterward', async () => {
    const sessionId = await createSession();
    const manager = managerOf();
    const session = getLiveSessionById(server!.core.accessor, sessionId)!;
    session.accessor.get(ISessionInteractionService).acquireConsumer('lease-test');
    const approvalId = session.accessor.get(ISessionApprovalService).enqueue({
      toolCallId: 'tc-lease', toolName: 'Bash', action: 'run', display: { kind: 'command', command: 'pwd' },
    }).id;
    const resume = manager.resume.bind(manager);
    const gate = deferred();
    const reached = deferred();
    vi.spyOn(manager, 'resume').mockImplementation(async (id, options) => {
      const handle = await resume(id, options);
      reached.resolve();
      await gate.promise;
      return handle;
    });
    const response = fetch(`${base}/api/sessions/${sessionId}/approvals/${approvalId}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ decision: 'approved' }),
    } as never).then(async (res) => (await res.json()) as { code: number });
    try {
      await Promise.race([reached.promise, response.then(() => { throw new Error('approval write finished before the barrier'); })]);
      expect(manager.residencyReport!().pinnedSessions).toBe(1);
      expect(await manager.evictIfIdle!(sessionId)).toBe(false);
    } finally {
      gate.resolve();
    }
    expect((await response).code).toBe(0);
    expect(manager.residencyReport!().pinnedSessions).toBe(0);
    expect(await manager.evictIfIdle!(sessionId)).toBe(true);
  });

  it('answers cold volatile interaction reads and missing actions without reactivating the session', async () => {
    const sessionId = await createSession();
    const manager = managerOf();
    expect(await manager.evictIfIdle!(sessionId)).toBe(true);
    const leases = spyLeases(manager);
    for (const kind of ['questions', 'approvals']) {
      const res = await fetch(`${base}/api/sessions/${sessionId}/${kind}?status=pending`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      expect((await res.json()) as { code: number; data: { items: unknown[] } }).toMatchObject({
        code: 0, data: { items: [] },
      });
    }
    const approval = await fetch(`${base}/api/sessions/${sessionId}/approvals/missing`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ decision: 'approved' }),
    } as never);
    const question = await fetch(`${base}/api/sessions/${sessionId}/questions/missing`, {
      method: 'POST', headers: authHeaders(server as RunningServer),
    } as never);
    expect((await approval.json()) as { code: number }).toMatchObject({ code: 40404 });
    expect((await question.json()) as { code: number }).toMatchObject({ code: 40405 });
    expect(leases.acquires).toEqual([]);
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
  });

  it.each(['questions', 'approvals'] as const)(
    'returns live %s interactions when restore completes during a cold index read',
    async (kind) => {
      const sessionId = await createSession();
      const manager = managerOf();
      expect(await manager.evictIfIdle!(sessionId)).toBe(true);
      const paused = pauseFirstIndexRead(sessionId);
      const response = fetch(`${base}/api/sessions/${sessionId}/${kind}?status=pending`, {
        headers: authHeaders(server as RunningServer),
      } as never).then(async (res) => (await res.json()) as {
        code: number; data: { items: Array<{ question_id?: string; approval_id?: string }> };
      });
      let interactionId: string;
      try {
        await Promise.race([paused.reached, response.then(() => { throw new Error('list finished before index read'); })]);
        expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
        expect(await manager.resume(sessionId)).toBeDefined();
        interactionId = enqueueInteraction(sessionId, kind);
      } finally {
        paused.release();
      }
      const leases = spyLeases(manager);
      const body = await response;
      expect(body.code).toBe(0);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]?.[kind === 'questions' ? 'question_id' : 'approval_id']).toBe(interactionId!);
      expect(leases.acquires).toEqual([`${sessionId}:operation`]);
      expect(leases.disposals).toEqual([sessionId]);
      expect(manager.residencyReport!().pinnedSessions).toBe(0);
    },
  );

  it('pins a restored session before awaiting its operation lease after the index race', async () => {
    const sessionId = await createSession();
    const manager = managerOf();
    expect(await manager.evictIfIdle!(sessionId)).toBe(true);
    const pausedIndex = pauseFirstIndexRead(sessionId);
    const response = fetch(`${base}/api/sessions/${sessionId}/questions?status=pending`, {
      headers: authHeaders(server as RunningServer),
    } as never).then(async (res) => (await res.json()) as {
      code: number; data: { items: Array<{ question_id: string }> };
    });
    const acquireEntered = deferred();
    const acquireGate = deferred();
    try {
      await Promise.race([pausedIndex.reached, response.then(() => { throw new Error('list finished before index read'); })]);
      expect(await manager.resume(sessionId)).toBeDefined();
      const questionId = enqueueInteraction(sessionId, 'questions');
      const originalResume = manager.resume.bind(manager);
      vi.spyOn(manager, 'resume').mockImplementation(async (id, options) => {
        acquireEntered.resolve();
        await acquireGate.promise;
        return originalResume(id, options);
      });
      const leases = spyLeases(manager);
      pausedIndex.release();
      await Promise.race([acquireEntered.promise, response.then(() => { throw new Error('list finished before lease acquire'); })]);
      expect(manager.residencyReport!().pinnedSessions).toBe(1);
      expect(await manager.evictIfIdle!(sessionId)).toBe(false);
      acquireGate.resolve();
      expect(await response).toMatchObject({ code: 0, data: { items: [{ question_id: questionId }] } });
      expect(leases.acquires).toEqual([`${sessionId}:operation`]);
      expect(leases.disposals).toEqual([sessionId]);
      expect(manager.residencyReport!().pinnedSessions).toBe(0);
    } finally {
      pausedIndex.release();
      acquireGate.resolve();
    }
  });

  it.each(['questions', 'approvals'] as const)(
    'submits to live %s interactions when restore completes during a cold index read',
    async (kind) => {
      const sessionId = await createSession();
      const manager = managerOf();
      expect(await manager.evictIfIdle!(sessionId)).toBe(true);
      const paused = pauseFirstIndexRead(sessionId);
      const interactionId = kind === 'questions' ? 'q-lease-race' : 'approval-lease-race';
      const response = fetch(`${base}/api/sessions/${sessionId}/${kind}/${interactionId}`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify(kind === 'questions'
          ? { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } }
          : { decision: 'approved' }),
      } as never).then(async (res) => (await res.json()) as { code: number; data?: { resolved: boolean } });
      try {
        await Promise.race([paused.reached, response.then(() => { throw new Error('action finished before index read'); })]);
        expect(await manager.resume(sessionId)).toBeDefined();
        expect(enqueueInteraction(sessionId, kind)).toBe(interactionId);
      } finally {
        paused.release();
      }
      const leases = spyLeases(manager);
      const body = await response;
      expect(body).toMatchObject({ code: 0, data: { resolved: true } });
      const interaction = getLiveSessionById(server!.core.accessor, sessionId)!
        .accessor.get(ISessionInteractionService);
      expect(interaction.listPending(kind === 'questions' ? 'question' : 'approval')).toEqual([]);
      expect(leases.acquires).toEqual([`${sessionId}:operation`]);
      expect(leases.disposals).toEqual([sessionId]);
      expect(manager.residencyReport!().pinnedSessions).toBe(0);
    },
  );

  it.each(['questions', 'approvals'] as const)(
    'does not activate a still-cold %s list after a delayed index read',
    async (kind) => {
      const sessionId = await createSession();
      const manager = managerOf();
      expect(await manager.evictIfIdle!(sessionId)).toBe(true);
      const leases = spyLeases(manager);
      const paused = pauseFirstIndexRead(sessionId);
      const response = fetch(`${base}/api/sessions/${sessionId}/${kind}?status=pending`, {
        headers: authHeaders(server as RunningServer),
      } as never).then(async (res) => (await res.json()) as { code: number; data: { items: unknown[] } });
      try {
        await paused.reached;
      } finally {
        paused.release();
      }
      expect(await response).toMatchObject({ code: 0, data: { items: [] } });
      expect(leases.acquires).toEqual([]);
      expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
    },
  );

  it.each(['questions', 'approvals'] as const)(
    'does not activate a still-cold %s action after a delayed index read',
    async (kind) => {
      const sessionId = await createSession();
      const manager = managerOf();
      expect(await manager.evictIfIdle!(sessionId)).toBe(true);
      const leases = spyLeases(manager);
      const paused = pauseFirstIndexRead(sessionId);
      const response = fetch(`${base}/api/sessions/${sessionId}/${kind}/missing`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify(kind === 'questions' ? { answers: {} } : { decision: 'approved' }),
      } as never).then(async (res) => (await res.json()) as { code: number });
      try {
        await paused.reached;
      } finally {
        paused.release();
      }
      expect((await response).code).toBe(kind === 'questions' ? 40405 : 40404);
      expect(leases.acquires).toEqual([]);
      expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
    },
  );
});

describe('cold session snapshot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-cold-snapshot-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function mainOf(sessionId: string) {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agents = session.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
    const main = agents.get('main');
    if (main === undefined) throw new Error('main agent missing');
    return { session, main };
  }

  async function snapshot(sessionId: string) {
    const res = await fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(0);
    return sessionSnapshotResponseSchema.parse(body.data);
  }

  async function expand(sessionId: string, data: Awaited<ReturnType<typeof snapshot>>) {
    let current = data;
    while (current.contentRefs?.length) {
      const response = await fetch(`${base}/api/klient/session-view/${sessionId}/transcript/content`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ agentId: 'main', ref: current.contentRefs[0] }),
      });
      const body = await response.json() as { code: number; data: ContentSegment };
      expect(body.code).toBe(0);
      current = applyContentSegment(current, body.data);
    }
    return current;
  }

  function messageShape(data: Awaited<ReturnType<typeof snapshot>>) {
    return data.messages.items.map((item) => ({ id: item.id, role: item.role, content: item.content }));
  }

  function restorationSpies() {
    const manager = server!.core.accessor.get(ISessionManager);
    return {
      manager,
      acquire: vi.spyOn(manager, 'acquire'),
      resume: vi.spyOn(manager, 'resume'),
      workspaceAcquire: vi.spyOn(server!.core.accessor.get(IWorkspaceInstanceManager), 'acquire'),
    };
  }

  it('publishes and drains the base roster while accounting and capability catalogs remain pending', async () => {
    const sessionId = await createSession();
    const { session } = await mainOf(sessionId);
    const metadata = session.accessor.get(ISessionMetadata);
    const children = Object.fromEntries(Array.from({ length: 127 }, (_, index) => [`example-child-${index}`, {
      type: 'sub' as const, parentAgentId: 'main', userLabel: `Example task ${index}`, status: 'completed' as const,
      completedAt: Date.parse('2026-02-02T00:00:00.000Z'),
    }]));
    await metadata.update({ agents: { ...(await metadata.read()).agents, ...children } });
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    await closeSessionById(server!.core.accessor, sessionId);
    const runtime = usageRuntime(server!.core);
    const accounting = await runtime.service.readSessionAccounting(workspaceId, sessionId);
    const gate = deferred();
    const readAccounting = vi.spyOn(runtime.service, 'readSessionAccounting').mockImplementation(async () => {
      await gate.promise;
      return accounting;
    });
    const capabilities = vi.spyOn(panelCapabilities, 'snapshotPanelCapabilities').mockImplementation(async () => {
      await gate.promise;
      throw new Error('capability catalog should not enter the roster path');
    });
    let fullResolved = false;
    const full = resolveSessionBindingFacts(server!.core, sessionId, workspaceId).then((facts) => {
      fullResolved = true;
      return facts;
    });
    void full.catch(() => {});
    const workspaceReads = vi.spyOn(server!.core.accessor.get(IWorkspaceService), 'get');
    try {
      expect((await full).usage?.accounting).toMatchObject({ ...accounting, freshness: 'current' });
      expect(readAccounting).not.toHaveBeenCalled();
      const response = await fetch(`${base}/api/klient/session-view/${sessionId}/snapshot`, {
        headers: authHeaders(server as RunningServer), signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json() as { code: number; data: unknown };
      expect(body.code).toBe(0);
      const preview = sessionSnapshotResponseSchema.parse(body.data);
      expect(preview.subagents!.length).toBeGreaterThan(0);
      expect(preview.subagents!.length).toBeLessThan(127);
      expect(preview.session.usage_error).toBeUndefined();
      workspaceReads.mockClear();
      const complete = await expand(sessionId, preview);
      expect(complete.subagents!.map((agent) => agent.id).toSorted()).toEqual(Object.keys(children).toSorted());
      expect(complete.as_of_seq).toBe(preview.as_of_seq);
      expect(complete.epoch).toBe(preview.epoch);
      expect(complete.agent_counts?.total).toBe(preview.agent_counts?.total);
      expect(workspaceReads).not.toHaveBeenCalled();
      expect(readAccounting).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
      expect(fullResolved).toBe(true);
      gate.resolve();
      expect((await full).usage?.accounting).toMatchObject({ ...accounting, freshness: 'current' });
      expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
    } finally {
      gate.resolve();
      await full;
      readAccounting.mockRestore();
      capabilities.mockRestore();
    }
  });

  it('matches a warm snapshot after close without resuming the session', async () => {
    const sessionId = await createSession();
    const { main } = await mainOf(sessionId);
    const memory = main.accessor.get(IAgentContextMemoryService);
    memory.append(...Array.from({ length: 101 }, (_, index) => ({
      id: `hist-${index}`,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `history-${index}` }],
      toolCalls: [],
    })));
    await main.accessor.get(IWireService).flush();
    const warm = await expand(sessionId, await snapshot(sessionId));
    await closeSessionById(server!.core.accessor, sessionId);
    const spies = restorationSpies();
    const coldPreview = await snapshot(sessionId);
    const cold = await expand(sessionId, coldPreview);
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.workspaceAcquire).not.toHaveBeenCalled();
    expect(coldPreview.session.message_count).toBe(101);
    expect(coldPreview.messages.has_more).toBe(true);
    expect(cold.messages.items).toHaveLength(100);
    expect(messageShape(cold)).toEqual(messageShape(warm));
    expect(cold.messages.items[0]?.content).toEqual([{ type: 'text', text: 'history-1' }]);
    expect(cold.messages.items.at(-1)?.content).toEqual([{ type: 'text', text: 'history-100' }]);
    expect(coldPreview.context_tokens).toBeUndefined();
    expect(coldPreview.max_context_tokens).toBeUndefined();
    expect(coldPreview.context_breakdown).toBeUndefined();
    expect(coldPreview.in_flight_turn).toBeNull();
    expect(coldPreview.pending_approvals).toEqual([]);
    expect(coldPreview.pending_questions).toEqual([]);
    spies.acquire.mockRestore();
    spies.resume.mockRestore();
    spies.workspaceAcquire.mockRestore();
    await spies.manager.resume(sessionId);
    const reopened = await expand(sessionId, await snapshot(sessionId));
    expect(messageShape(reopened)).toEqual(messageShape(cold));
    expect(reopened.as_of_seq).toBe(cold.as_of_seq);
    expect(reopened.epoch).toBe(cold.epoch);
  });

  it('keeps compacted and edited logical context and drops the replaced history', async () => {
    const sessionId = await createSession();
    const { main } = await mainOf(sessionId);
    const memory = main.accessor.get(IAgentContextMemoryService);
    memory.append(
      { role: 'user', content: [{ type: 'text', text: 'original-hidden' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'original-answer' }], toolCalls: [] },
    );
    memory.applyCompaction({
      summary: 'folded-summary',
      compactedCount: memory.get().length,
      tokensBefore: 40,
    });
    memory.append({
      id: 'edited-user',
      role: 'user',
      content: [{ type: 'text', text: 'edited-input' }],
      toolCalls: [],
    });
    await main.accessor.get(IWireService).flush();
    const warm = await snapshot(sessionId);
    const warmText = JSON.stringify(warm.messages.items);
    expect(warmText).toContain('folded-summary');
    expect(warmText).toContain('edited-input');
    expect(warmText).toContain('original-hidden');
    expect(warmText).not.toContain('original-answer');
    await closeSessionById(server!.core.accessor, sessionId);
    const spies = restorationSpies();
    const cold = await snapshot(sessionId);
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.workspaceAcquire).not.toHaveBeenCalled();
    expect(messageShape(cold)).toEqual(messageShape(warm));
    expect(cold.session.message_count).toBe(warm.session.message_count);
    expect(cold.messages.has_more).toBe(warm.messages.has_more);
  });

  it('reads a full task receipt from a cold session after metadata outcomes are split', async () => {
    const sessionId = await createSession();
    const { session, main } = await mainOf(sessionId);
    const receipt = 'complete receipt '.repeat(512);
    const tasks = main.accessor.get(IAgentTaskService);
    const taskId = tasks.registerTask({
      idPrefix: 'agent', kind: 'agent', description: 'saved result',
      toInfo: (base) => ({ ...base, kind: 'agent', agentId: 'saved-child' }),
      start: async (sink) => { sink.setFinalOutput?.(receipt); await sink.settle({ status: 'completed' }); },
    });
    await tasks.wait(taskId);
    const otherId = tasks.registerTask({
      idPrefix: 'agent', kind: 'agent', description: 'other saved result',
      toInfo: (base) => ({ ...base, kind: 'agent', agentId: 'other-child' }),
      start: async (sink) => { sink.setFinalOutput?.('other result'); await sink.settle({ status: 'completed' }); },
    });
    await tasks.wait(otherId);
    await session.accessor.get(ISessionMetadata).registerAgent('saved-child', {
      type: 'sub', taskId, status: 'completed', resultSummary: receipt,
    });
    await closeSessionById(server!.core.accessor, sessionId);
    const spies = restorationSpies();
    const docs = server!.core.accessor.get(IAtomicDocumentStore);
    const reads = vi.spyOn(docs, 'get');
    const lists = vi.spyOn(docs, 'list');
    const response = await fetch(`${base}/api/sessions/${sessionId}/tasks/${taskId}?with_output=true&output_bytes=32768`, {
      headers: authHeaders(server as RunningServer),
    });
    const body = await response.json() as { code: number; data: { output_preview: string } };
    expect(body.code).toBe(0);
    expect(body.data.output_preview).toBe(receipt);
    expect(lists).not.toHaveBeenCalled();
    expect(reads.mock.calls.every(([, key]) => key === `${taskId}.json` || key === 'state.json')).toBe(true);
    reads.mockClear();
    const pageResponse = await fetch(`${base}/api/sessions/${sessionId}/tasks?page_size=1`, { headers: authHeaders(server as RunningServer) });
    const page = await pageResponse.json() as { code: number; data: { items: unknown[]; has_more: boolean; next_offset: number } };
    expect(page.code).toBe(0);
    expect(page.data).toMatchObject({ items: [expect.any(Object)], has_more: true, next_offset: 1 });
    expect(reads.mock.calls.filter(([, key]) => key.endsWith('.json') && key !== 'state.json')).toHaveLength(1);
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
  });

  it('reads saved permission, plan, and completed subagent roster without a live handle', async () => {
    const sessionId = await createSession();
    const { session, main } = await mainOf(sessionId);
    main.accessor.get(IAgentPermissionModeService).setMode('yolo', 'runtime');
    await main.accessor.get(IAgentPlanService).enter('plan-cold');
    const childId = 'child-cold';
    await session.accessor.get(IAgentLifecycleService).create({ agentId: childId });
    await session.accessor.get(ISessionMetadata).updateAgent(childId, (current) => ({
      ...current,
      type: 'sub',
      parentAgentId: 'main',
      status: 'completed',
      completedAt: Date.parse('2026-02-02T00:00:00.000Z'),
      thinkingEffort: 'high',
      thinkingEffortExplicit: true,
    }));
    await main.accessor.get(IWireService).flush();
    const warm = await snapshot(sessionId);
    await closeSessionById(server!.core.accessor, sessionId);
    const spies = restorationSpies();
    const cold = await snapshot(sessionId);
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.workspaceAcquire).not.toHaveBeenCalled();
    expect(cold.session.agent_config.permission_mode).toBe('yolo');
    expect(cold.session.agent_config.plan_mode).toBe(true);
    expect(cold.session.agent_config.permission_mode).toBe(warm.session.agent_config.permission_mode);
    expect(cold.session.agent_config.plan_mode).toBe(warm.session.agent_config.plan_mode);
    expect(cold.session.agent_config.model).toBe(warm.session.agent_config.model);
    expect((cold.subagents ?? []).map((subagent) => subagent.id)).toEqual(
      (warm.subagents ?? []).map((subagent) => subagent.id),
    );
    expect(cold.agent_counts).toEqual(warm.agent_counts);
    const child = (cold.subagents ?? []).find((subagent) => subagent.id === childId);
    expect(child?.thinking_effort).toBe('high');
    expect(child?.live).not.toBe(true);
  });

  it('cancels an in-flight cold snapshot read and serves the saved context after reopen', async () => {
    const sessionId = await createSession();
    const { main } = await mainOf(sessionId);
    main.accessor.get(IAgentContextMemoryService).append({
      id: 'kept-user',
      role: 'user',
      content: [{ type: 'text', text: 'kept' }],
      toolCalls: [],
    });
    await main.accessor.get(IWireService).flush();
    await closeSessionById(server!.core.accessor, sessionId);
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const raw = concreteMethod(storage, 'readStream');
    const requests = vi.spyOn(server!.core.accessor.get(ICpuWorkerService), 'request');
    const closed = deferred();
    let releaseRead = (): void => {};
    let observed: AbortSignal | undefined;
    const read = vi.spyOn(storage, 'readStream').mockImplementation((scope, key, range, options) => {
      if (String(scope).endsWith('/agents/main') && key === AGENT_WIRE_RECORD_KEY) {
        observed = options?.signal;
        const signal = options?.signal;
        const held = new Promise<void>((resolve) => {
          releaseRead = resolve;
          if (signal?.aborted === true) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return (async function* () {
          try {
            await held;
            signal?.throwIfAborted();
            yield* raw.call(storage, scope, key, range, options);
          } finally { closed.resolve(); }
        })();
      }
      return raw.call(storage, scope, key, range, options);
    });
    const controller = new AbortController();
    const spies = restorationSpies();
    const pending = fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
      headers: authHeaders(server as RunningServer),
      signal: controller.signal,
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(observed).toBeDefined());
      const workerSignal = requests.mock.calls.find(([operation]) => (operation as { type?: string }).type === 'wire.context')?.[1]?.signal;
      expect(workerSignal).toBe(observed);
      controller.abort();
      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(observed?.aborted).toBe(true));
      expect(workerSignal?.aborted).toBe(true);
      await closed.promise;
      expect(spies.acquire).not.toHaveBeenCalled();
      expect(spies.resume).not.toHaveBeenCalled();
      expect(spies.workspaceAcquire).not.toHaveBeenCalled();
    } finally {
      releaseRead();
      read.mockRestore();
      requests.mockRestore();
      spies.acquire.mockRestore();
      spies.resume.mockRestore();
      spies.workspaceAcquire.mockRestore();
    }
    const cold = await snapshot(sessionId);
    expect(cold.messages.items.some((item) => JSON.stringify(item.content).includes('kept'))).toBe(true);
    expect(spies.manager.residencyReport?.().liveSessions ?? 0).toBe(0);
  });

  it('reports an unknown session without resuming it', async () => {
    const spies = restorationSpies();
    const res = await fetch(`${base}/api/sessions/missing-session/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40401);
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.workspaceAcquire).not.toHaveBeenCalled();
  });

  it('keeps a cold read cold when the session is restored concurrently', async () => {
    const sessionId = await createSession();
    const { main } = await mainOf(sessionId);
    main.accessor.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'race-text' }],
      toolCalls: [],
    });
    await main.accessor.get(IWireService).flush();
    await closeSessionById(server!.core.accessor, sessionId);
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const raw = concreteMethod(storage, 'readStream');
    let releaseRead = (): void => {};
    let held = false;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const read = vi.spyOn(storage, 'readStream').mockImplementation((scope, key, range, options) => {
      if (!held && String(scope).endsWith('/agents/main') && key === AGENT_WIRE_RECORD_KEY) {
        held = true;
        return (async function* () {
          entered();
          await new Promise<void>((resolve) => { releaseRead = resolve; });
          yield* raw.call(storage, scope, key, range, options);
        })();
      }
      return raw.call(storage, scope, key, range, options);
    });
    const spies = restorationSpies();
    const pending = fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    }).then(async (res) => (await res.json()) as { code: number; data: unknown });
    void pending.catch(() => undefined);
    try {
      await enteredPromise;
      expect(spies.acquire).not.toHaveBeenCalled();
      expect(spies.resume).not.toHaveBeenCalled();
      expect(spies.workspaceAcquire).not.toHaveBeenCalled();
      await spies.manager.resume(sessionId);
      releaseRead();
      const body = await pending;
      expect(body.code).toBe(0);
      const cold = sessionSnapshotResponseSchema.parse(body.data);
      expect(spies.acquire).not.toHaveBeenCalled();
      expect(JSON.stringify(cold.messages.items)).toContain('race-text');
      expect(cold.in_flight_turn).toBeNull();
      expect(cold.pending_approvals).toEqual([]);
      expect(cold.pending_questions).toEqual([]);
    } finally {
      releaseRead();
      read.mockRestore();
      spies.acquire.mockRestore();
      spies.resume.mockRestore();
      spies.workspaceAcquire.mockRestore();
    }
  });
});

function concreteMethod<T extends object, K extends keyof T>(target: T, key: K): T[K] {
  let host: object | null = target;
  while (host !== null) {
    const value: unknown = Object.getOwnPropertyDescriptor(host, key)?.value;
    if (typeof value === 'function') return value as T[K];
    host = Object.getPrototypeOf(host) as object | null;
  }
  throw new Error(`${String(key)} is not a concrete method`);
}
