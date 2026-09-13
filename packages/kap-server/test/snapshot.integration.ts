import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  type Event2,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
  IEventBus,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentUsageService,
  ISessionInteractionService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLifecycleService,
  IWireService,
  ISessionManager,
  ITelemetryService,
  IWorkspaceService,
  getLiveSessionById,
  resumeSessionById,
  type ContextMessage,
} from '@kiki/agent-core-v2';
import { sessionSnapshotResponseSchema } from '../src/protocol/rest-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSnapshotRoutes } from '../src/routes/snapshot';
import { type RunningServer, startServer } from '../src/start';
import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

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
  it('keeps legacy parity while transcript mode uses materialized display fields', async () => {
    const sessionId = 'sess_snapshot';
    const promptId = 'msg_snapshot_prompt';
    const workspaceId = 'wd_snapshot_012345abcdef';
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const loadParts = vi.fn(async (parts: unknown) => parts);
    const main = {
      accessor: fakeAccessor([
        [IAgentProfileService, { getModel: () => 'provider/session-model' }],
        [IAgentPermissionModeService, { mode: 'yolo' }],
        [IAgentPlanService, { status: async () => ({ id: 'plan', content: '', path: '' }) }],
        [IAgentSwarmService, { isActive: true }],
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
    const session = {
      accessor: fakeAccessor([
        [ISessionContext, { workspaceId }],
        [
          ISessionMetadata,
          {
            read: async () => ({
              id: sessionId,
              title: 'Snapshot',
              createdAt: now,
              updatedAt: now,
              archived: false,
              agents: {
                'agent-1': {
                  type: 'sub',
                  parentAgentId: 'main',
                  labels: { parentAgentId: 'main', swarmItem: 'Research API limits' },
                  displayName: 'explore',
                  model: 'provider/metadata-model',
                  thinkingEffort: 'high',
                },
              },
            }),
          },
        ],
        [IAgentLifecycleService, { get: () => main, create: async () => main }],
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
            resume: async () => session,
            get: () => undefined,
            list: () => [],
          },
        ],
        [IWorkspaceService, { get: async () => ({ root: '/workspace' }) }],
        [ITelemetryService, { withContext: () => ({ track2: () => {} }) }],
      ]),
    };
    const getTranscriptToolCallCounts = vi.fn(async () => new Map([['agent-1', 3]]));
    const getMaterializedTranscriptToolCallCounts = vi
      .fn<() => ReadonlyMap<string, number>>()
      .mockReturnValueOnce(new Map([['agent-1', 2]]))
      .mockReturnValue(new Map());
    const getSnapshotState = vi.fn(async (_sessionId: string, options: { capture?: () => Promise<unknown> }) => ({
      seq: 1,
      epoch: 'ep_snapshot',
      captured: await options.capture?.(),
      pendingApprovals: [{
        approval_id: 'approval-snapshot', session_id: sessionId, turn_id: 7,
        tool_call_id: 'tc-approval', tool_name: 'Bash', action: 'run',
        tool_input_display: { command: 'pwd' },
        created_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
      }],
      pendingQuestions: [],
      contextMessages: [
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
          status: 'running',
          subagent_phase: 'working',
          parent_tool_call_id: 'tc_swarm_1',
          tool_call_count: 5,
          swarm_index: 0,
          run_in_background: false,
          created_at: new Date(now).toISOString(),
        },
      ],
    }));
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
          reply: { send(payload: unknown): unknown },
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
    expect(compact.in_flight_turn).toMatchObject({
      turn_id: 7,
      assistant_text: 'Hello',
      current_prompt_id: promptId,
    });
    expect(compact.session.agent_config).toMatchObject({
      model: 'provider/session-model',
      permission_mode: 'yolo',
      plan_mode: true,
      swarm_mode: true,
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
        tool_call_count: 3,
      }),
    ]);
    expect(getSnapshotState).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ captureMessages: false, capture: expect.any(Function) }));
    expect(getMaterializedTranscriptToolCallCounts).not.toHaveBeenCalled();
    expect(getTranscriptToolCallCounts).toHaveBeenCalledWith(sessionId, ['agent-1']);
    expect(loadParts).not.toHaveBeenCalled();

    getTranscriptToolCallCounts.mockResolvedValueOnce(new Map());
    const unmaterialized = await invoke('transcript');
    expect(unmaterialized.subagents?.[0]?.tool_call_count).toBeUndefined();
    expect(getTranscriptToolCallCounts).toHaveBeenCalledTimes(2);
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
    expect(getTranscriptToolCallCounts).toHaveBeenCalledTimes(3);
    expect(loadParts).toHaveBeenCalledOnce();
    expect(legacy.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        subagent_phase: 'working',
        parent_agent_id: 'main',
        parent_tool_call_id: 'tc_swarm_1',
        label: 'Research API limits',
        tool_call_count: 3,
        swarm_index: 0,
        run_in_background: false,
      }),
    ]);
    expect(legacy.subagents?.[0]?.model).toBeUndefined();
    expect(legacy.subagents?.[0]?.thinking_effort).toBeUndefined();
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
    const sid = await createSession();
    const snap = await snapshot(sid);

    expect(snap.session.id).toBe(sid);
    expect(snap.as_of_seq).toBe(2);
    expect(snap.epoch).toMatch(/^ep_/);
    expect(snap.messages.items).toEqual([]);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.context_tokens).toBe(0);
    expect(snap.max_context_tokens).toBeUndefined();
    expect(snap.context_breakdown).toBeUndefined();
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.pending_questions).toEqual([]);
  });

  it.each([
    { label: 'missing', content: undefined, count: undefined },
    {
      label: 'corrupt',
      content: ['not-json', '{}'].join(String.fromCodePoint(10)) + String.fromCodePoint(10),
      count: undefined,
    },
    { label: 'empty', content: '', count: 0 },
  ] as const)('[STAT-R3] compact snapshot keeps $label child count semantics', async ({
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
      swarmIndex: 0,
      runInBackground: false,
    } as unknown as Event2<any>);

    const snap = await snapshot(sid, 'transcript');
    const child = (snap.subagents ?? []).find((subagent) => subagent.id === childId);
    expect(child).toBeDefined();
    expect(child?.tool_call_count).toBe(count);
  });

  it('keeps the legacy snapshot readable and skips history work in transcript mode', async () => {
    const sid = await createSession();
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
    const readEntered = deferred();
    const releaseRead = deferred();
    const futureAppended = deferred();
    const originalRead = appendLog.read.bind(appendLog) as typeof appendLog.read;
    const originalAppend = appendLog.append.bind(appendLog) as typeof appendLog.append;
    let shouldPause = true;
    const readSpy = vi.spyOn(appendLog, 'read').mockImplementation(<R>(scope: string, key: string) => {
      const source = originalRead<R>(scope, key);
      return (async function* (): AsyncIterableIterator<R> {
        if (shouldPause && scope === mainScope && key === AGENT_WIRE_RECORD_KEY) {
          shouldPause = false;
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

    expect(seqBeforeReadRelease).toBeGreaterThan(boundary.as_of_seq);
    expect(current.as_of_seq).toBe(boundary.as_of_seq);
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

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
    expect(snap.messages.items).toHaveLength(2);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('hello-from-disk');
    expect((snap.messages.items[1]!.content[0] as { text: string }).text).toBe('hi-from-disk');
    expect(snap.epoch).toMatch(/^ep_/);
  });

  it('omits persisted subagent relations without running or terminal evidence', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const sub = await session.accessor.get(IAgentLifecycleService).create({
      agentId: 'agent-1',
      delegator: { kind: 'agent', agentId: 'main' },
      labels: { parentAgentId: 'main', swarmItem: 'Research API limits' },
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
      labels: { parentAgentId: 'main', swarmItem: 'Research API limits' },
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
    expect(snap.subagents).toEqual([]);
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
