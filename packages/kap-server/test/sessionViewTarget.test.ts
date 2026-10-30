import { channel } from 'node:diagnostics_channel';
import { describe, expect, it, vi } from 'vitest';
import type { SessionViewSignal } from '@kiki/klient';
import type { SessionSnapshotResponse } from '@kiki/protocol';
import * as snapshotReads from '../src/routes/snapshot';
import { AgentTranscript, TRANSCRIPT_COVERAGE_VERSION, type AgentTranscriptSnapshot } from '@kiki/transcript';
import { SessionViewTarget } from '../src/transport/klient/sessionViewTarget';
import { SessionViewHttpConnection } from '../src/transport/klient/sessionViewHttp';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import { readColdSessionViewBaseline } from '../src/transport/klient/sessionViewReads';

function durable(seq: number) {
  return { type: 'turn.ended', session_id: 's1', seq, epoch: 'session-epoch', timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'turn.ended' } };
}

function coldPageReader(read: (sessionId: string, agentId: string, signal: AbortSignal) => Promise<AgentTranscriptSnapshot>) {
  return vi.fn(async (sessionId: string, agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, signal: AbortSignal) =>
    project(await read(sessionId, agentId, signal)));
}

function shellSnapshot(epoch = 'session-epoch'): SessionSnapshotResponse {
  return { as_of_seq: 10, epoch, messages: { items: [], has_more: false }, in_flight_turn: null,
    pending_approvals: [], pending_questions: [], subagents: [],
    session: { id: 's1', workspace_id: 'workspace-test', title: 'Snapshot title', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', busy: false, metadata: { cwd: '/fixture/workspace' }, agent_config: { model: '' },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
        total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
      permission_rules: [], message_count: 0, last_seq: 10 } };
}

describe('SessionViewTarget', () => {
  it('streams bootstrap transcripts before its shell while preserving later title, roster and rewrite hints', async () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(4, true);
    target.send({ ...durable(9), type: 'session.meta.updated', payload: { type: 'session.meta.updated', title: 'old title' } });
    target.send({ ...durable(10), type: 'agent.created', payload: { type: 'agent.created', agentId: 'child' } });
    target.send({ ...durable(11), type: 'session.meta.updated', payload: { type: 'session.meta.updated', title: 'new title' } });
    target.send({ ...durable(12), type: 'event.session.history_rewritten', payload: {
      type: 'event.session.history_rewritten', reason: 'regenerate', target_message_id: 'message-test',
    } });
    target.send({ ...durable(0), type: 'transcript.reset', payload: { type: 'transcript.reset',
      session_id: 's1', agent_id: 'main', snapshot: new AgentTranscript('main').snapshot(), grade: 'delta',
      coverage: { kind: 'unknown', hasMoreOlder: true }, cursor: { seq: 3, epoch: 'transcript-epoch' } } });
    await target.drain();
    expect(signals.map((signal) => signal.type)).toEqual(['transcript']);
    target.seedSnapshot(shellSnapshot());
    target.finish({ seq: 10, epoch: 'session-epoch' }, false);
    expect(signals.map((signal) => signal.type)).toEqual(['transcript', 'snapshot', 'sessionCursorAdvanced', 'sessionCursorAdvanced', 'historyRewritten', 'ready']);
    expect(signals[2]).toMatchObject({ rosterAgentId: 'child', cursor: { seq: 10 } });
    expect(signals[3]).toMatchObject({ title: 'new title', cursor: { seq: 11 } });
    expect(signals.at(-1)).toMatchObject({ currentSessionCursor: { seq: 12, epoch: 'session-epoch' } });
  });

  it('requires recovery when a bootstrap shell belongs to another durable epoch', async () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(2, true);
    target.send(durable(11));
    await target.drain();
    target.seedSnapshot(shellSnapshot('new-session-epoch'));
    target.finish({ seq: 10, epoch: 'new-session-epoch' }, false);
    expect(signals.map((signal) => signal.type)).toEqual(['snapshot', 'resyncRequired']);
    expect(signals[1]).toMatchObject({ reason: 'epoch_changed', currentSessionCursor: { seq: 10, epoch: 'new-session-epoch' } });
  });

  it.each(['complete', 'detach'] as const)('starts bootstrap seed and shell concurrently after attachment and preserves %s', async (outcome) => {
    let finishShell!: (snapshot: SessionSnapshotResponse) => void;
    let signal: AbortSignal | undefined;
    let attachedTarget: SessionViewTarget | undefined;
    const shell = vi.spyOn(snapshotReads, 'assembleBrowseSnapshot').mockImplementation(async (_core, _broadcaster, _sessionId, timing) => {
      expect(attachedTarget).toBeDefined();
      signal = timing?.signal;
      return new Promise((resolve) => { finishShell = resolve; });
    });
    const broadcaster = { subscribe: vi.fn(async (_sessionId, target: SessionViewTarget) => { attachedTarget = target; return true; }),
      unsubscribe: vi.fn(), getBufferedSince: vi.fn(), flushTranscriptSeed: vi.fn(async () => {
        attachedTarget!.send({ ...durable(0), type: 'transcript.reset', payload: { type: 'transcript.reset',
          session_id: 's1', agent_id: 'main', snapshot: new AgentTranscript('main').snapshot(), grade: 'delta',
          coverage: { kind: 'unknown', hasMoreOlder: true }, cursor: { seq: 3, epoch: 'transcript-epoch' } } });
      }) };
    const send = vi.fn(); const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => ({ get: () => ({}) }) } } as never });
    try {
      connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1,
        transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
        input: { bootstrap: true, sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } } } });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'transcript' }) })));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript']);
      expect(shell).toHaveBeenCalledOnce();
      expect(broadcaster.getBufferedSince).not.toHaveBeenCalled();
      if (outcome === 'detach') {
        connection.receive({ type: 'view_detach', id: 'v1' });
        expect(signal?.aborted).toBe(true);
      } else attachedTarget!.send(durable(11));
      finishShell(shellSnapshot());
      if (outcome === 'complete') {
        await vi.waitFor(() => expect(send.mock.calls.at(-1)?.[0].data.type).toBe('ready'));
        expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript', 'snapshot', 'sessionCursorAdvanced', 'ready']);
        expect(send.mock.calls.at(-1)?.[0].data.currentSessionCursor).toEqual({ seq: 11, epoch: 'session-epoch' });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript']);
      }
      expect(errors).not.toHaveBeenCalled();
    } finally { connection.dispose(); shell.mockRestore(); }
  });

  it('reports a failed bootstrap shell and aborts a concurrent cold body read', async () => {
    let bodySignal: AbortSignal | undefined;
    let failShell!: (error: Error) => void;
    const shell = vi.spyOn(snapshotReads, 'assembleBrowseSnapshot').mockImplementation(() => new Promise((_resolve, reject) => { failShell = reject; }));
    const service = { readColdRoster: vi.fn(async () => [{ agentId: 'main', type: 'main' }]),
      readColdPageSnapshot: coldPageReader(async (_session, _agent, signal) => {
        bodySignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }) };
    const broadcaster = { unsubscribe: vi.fn(), getCursor: vi.fn() };
    const send = vi.fn(); const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => ({ get: () => undefined }) } } as never, service: service as never });
    try {
      connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1,
        transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
        input: { bootstrap: true, sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } } } });
      await vi.waitFor(() => expect(bodySignal).toBeDefined());
      failShell(new Error('shell failed'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('v1', expect.objectContaining({ message: 'shell failed' })));
      expect(bodySignal?.aborted).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally { connection.dispose(); shell.mockRestore(); }
  });

  it('deduplicates replay and live durable work before acknowledging the latest watermark', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(4);
    target.send(durable(11));
    target.send(durable(12));
    target.replay(durable(11));
    target.finish({ seq: 11, epoch: 'session-epoch' }, true);
    expect(signals).toEqual([
      { type: 'sessionCursorAdvanced', cursor: { seq: 11, epoch: 'session-epoch' }, generation: 4 },
      { type: 'sessionCursorAdvanced', cursor: { seq: 12, epoch: 'session-epoch' }, generation: 4 },
      { type: 'ready', currentSessionCursor: { seq: 12, epoch: 'session-epoch' }, reconnected: true, generation: 4 },
    ]);
  });

  it('projects existing agent.created and agent.disposed events as roster-refresh hints', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(3);
    target.send({
      ...durable(13), type: 'agent.created',
      payload: { type: 'agent.created', agentId: 'agent-1', time: 1_000 },
    });
    target.send({
      ...durable(14), type: 'agent.disposed',
      payload: { type: 'agent.disposed', agentId: 'agent-1', time: 1_100 },
    });
    target.finish({ seq: 14, epoch: 'session-epoch' }, false);
    expect(signals.slice(0, 2)).toEqual([
      {
        type: 'sessionCursorAdvanced', rosterAgentId: 'agent-1',
        cursor: { seq: 13, epoch: 'session-epoch' }, generation: 3,
      },
      {
        type: 'sessionCursorAdvanced', rosterAgentId: 'agent-1',
        cursor: { seq: 14, epoch: 'session-epoch' }, generation: 3,
      },
    ]);
  });

  it('refreshes child roster activity at the existing durable watermark without progress churn', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    const activity = (agentId: string, kind: string) => ({
      ...durable(12), type: 'agent.status.updated', volatile: true,
      payload: { type: 'agent.status.updated', agentId, phase: { kind, turnId: 1 } },
    });
    target.begin(1);
    target.send(durable(12));
    target.send(activity('child', 'running'));
    target.send(activity('child', 'streaming'));
    target.send(activity('main', 'running'));
    target.finish({ seq: 12, epoch: 'session-epoch' }, false);
    expect(signals.filter((signal) => signal.type === 'sessionCursorAdvanced' && signal.rosterAgentId === 'child')).toHaveLength(1);
    target.send(activity('child', 'idle'));
    target.send(activity('child', 'idle'));
    expect(signals.at(-1)).toEqual({ type: 'sessionCursorAdvanced', rosterAgentId: 'child', cursor: { seq: 12, epoch: 'session-epoch' }, generation: 1 });
    expect(signals.filter((signal) => signal.type === 'sessionCursorAdvanced' && signal.rosterAgentId === 'child')).toHaveLength(2);
  });

  it('preserves rewrite and epoch invalidation signals', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(2);
    target.replay({ ...durable(9), payload: { type: 'event.session.history_rewritten', reason: 'regenerate', target_message_id: 'message-1' } });
    target.sendControl({ type: 'resync_required', payload: { reason: 'epoch_changed', current_seq: 0, epoch: 'new-epoch' } });
    target.finish({ seq: 0, epoch: 'new-epoch' }, false);
    expect(signals).toEqual([{ type: 'resyncRequired', reason: 'epoch_changed', currentSessionCursor: { seq: 0, epoch: 'new-epoch' }, generation: 2 }]);
  });

  it('refreshes a child binding change within the same idle phase without token churn', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    const status = (model: string, thinkingEffort: string, contextTokens = 1) => ({
      ...durable(12), type: 'agent.status.updated', volatile: true,
      payload: { type: 'agent.status.updated', agentId: 'child', phase: { kind: 'idle' },
        model, thinkingEffort, contextTokens },
    });
    target.begin(1);
    target.finish({ seq: 12, epoch: 'session-epoch' }, false);
    target.send(status('example/old', 'high'));
    target.send(status('example/new', 'high'));
    target.send(status('example/new', 'xhigh'));
    target.send(status('example/new', 'xhigh', 500));
    expect(signals.filter((signal) => signal.type === 'sessionCursorAdvanced' && signal.rosterAgentId === 'child'))
      .toHaveLength(3);
  });

  it('ignores other sessions global fanout while retaining its suppressed durable cursor', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(1);
    target.send({ ...durable(99), session_id: 's2', type: 'event.session.work_changed' });
    target.send({ ...durable(100), session_id: undefined, type: 'event.config.changed' });
    target.sendDurableCursor({ seq: 12, epoch: 'session-epoch' });
    target.finish({ seq: 11, epoch: 'session-epoch' }, false);
    expect(signals).toEqual([
      { type: 'sessionCursorAdvanced', cursor: { seq: 12, epoch: 'session-epoch' }, generation: 1 },
      { type: 'ready', currentSessionCursor: { seq: 12, epoch: 'session-epoch' }, generation: 1, reconnected: false },
    ]);
  });

  it('detaches a source that finishes attachment after the client disconnects', async () => {
    let resolveAttach: ((attached: boolean) => void) | undefined;
    const broadcaster = {
      subscribe: vi.fn(() => new Promise<boolean>((resolve) => { resolveAttach = resolve; })),
      unsubscribe: vi.fn(), getBufferedSince: vi.fn(), flushTranscriptSeed: vi.fn(),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors);
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION, input: { sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } } } });
    await vi.waitFor(() => { expect(resolveAttach).toBeDefined(); });
    connection.dispose();
    resolveAttach!(true);
    await vi.waitFor(() => { expect(broadcaster.unsubscribe).toHaveBeenCalled(); });
    expect(broadcaster.getBufferedSince).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([false, true])('projects only the requested cold child and cancels detached reads (%s)', async (detach) => {
    const manager = { get: vi.fn(() => undefined), resume: vi.fn(), acquire: vi.fn(), onDidCreateSession: vi.fn(() => ({ dispose: vi.fn() })) };
    const core = { accessor: { get: () => manager } };
    let resolveRead: ((snapshot: AgentTranscriptSnapshot) => void) | undefined;
    let readSignal: AbortSignal | undefined;
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => Array.from({ length: 456 }, (_, i) => ({ agentId: `agent-${i}`, type: 'sub' }))),
      readColdPageSnapshot: coldPageReader((_sessionId, _agentId, signal: AbortSignal) => {
        readSignal = signal;
        return new Promise((resolve) => { resolveRead = resolve; });
      }),
    };
    const broadcaster = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCursor: vi.fn(async () => ({ seq: 7, epoch: 'cold-session' })) };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: core as never, service: service as never });
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1,
      transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 0 }, transcriptGrades: { '*': 'turn', main: 'off', 'agent-27': 'delta' } } } });
    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    if (detach) connection.receive({ type: 'view_detach', id: 'v1' });
    const prompt = 'x'.repeat(160_000);
    const snapshot: AgentTranscriptSnapshot = { ...new AgentTranscript('agent-27').snapshot(), toolCallCountKnown: true,
      items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt, steps: [] }] };
    resolveRead!(snapshot);
    await vi.waitFor(() => {
      if (detach) expect(readSignal?.aborted).toBe(true);
      else expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.readColdPageSnapshot).toHaveBeenCalledExactlyOnceWith('s1', 'agent-27', expect.any(Function), expect.any(AbortSignal), false, undefined, false, true);
    const result = service.readColdPageSnapshot.mock.results[0];
    if (result?.type !== 'return') throw new Error('Cold page reader must complete the projection');
    const projected = (await result.value).items[0]!;
    expect(projected.kind).toBe('turn');
    if (projected.kind !== 'turn') throw new Error('Cold projection must preserve the turn header');
    expect(projected.prompt).not.toBe(prompt);
    expect(projected.contentRefs).toContainEqual(expect.objectContaining({ source: { kind: 'turn', id: 't0' }, path: ['prompt'], total: prompt.length }));
    expect(snapshot.items[0]).toEqual(expect.objectContaining({ prompt }));
    expect(broadcaster.subscribe).not.toHaveBeenCalled();
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.acquire).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    if (detach) expect(send).not.toHaveBeenCalled();
    else expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ agent_id: 'agent-27', coverage: expect.objectContaining({ kind: 'full' }) }),
    }) }));
    connection.dispose();
  });

  it.each(['upgrade', 'detach', 'dispose', 'failure'])('waits for activation settlement and handles %s without reviving old views', async (outcome) => {
    let activate!: (event: { sessionId: string }) => void;
    let settle!: () => void;
    let fail!: (error: Error) => void;
    let live = false;
    const listenerDispose = vi.fn();
    const manager = {
      get: () => live ? {} : undefined,
      onDidCreateSession: (callback: typeof activate) => { activate = callback; return { dispose: listenerDispose }; },
      whenResumeSettled: vi.fn(() => new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; })),
    };
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => [{ agentId: 'main', type: 'main' }]),
      readColdPageSnapshot: coldPageReader(async () => ({ ...new AgentTranscript('main').snapshot(), toolCallCountKnown: true })),
    };
    const broadcaster = {
      subscribe: vi.fn(async () => true), unsubscribe: vi.fn(),
      getCursor: vi.fn(async () => ({ seq: 7, epoch: 'journal-epoch' })),
      getBufferedSince: vi.fn(async () => ({ events: [], resyncRequired: false, currentSeq: 7, epoch: 'journal-epoch' })),
      flushTranscriptSeed: vi.fn(async () => {}),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => manager } } as never, service: service as never });
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1,
      transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7, epoch: 'journal-epoch' }, transcriptGrades: { main: 'delta' },
        transcriptSince: { main: { seq: 0, epoch: 'cold:s1:main' } } } } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: 'ready', currentSessionCursor: { seq: 7, epoch: 'journal-epoch' },
    }) })));
    send.mockClear();
    live = true;
    activate({ sessionId: 's1' });
    expect(broadcaster.subscribe).not.toHaveBeenCalled();
    if (outcome === 'detach') connection.receive({ type: 'view_detach', id: 'v1' });
    if (outcome === 'dispose') connection.dispose();
    if (outcome === 'failure') fail(new Error('restore failed'));
    else settle();
    if (outcome === 'upgrade') {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'resyncRequired' }) })));
      expect(broadcaster.subscribe).toHaveBeenCalledExactlyOnceWith('s1', expect.any(SessionViewTarget), undefined,
        { main: 'delta' }, { deferTranscriptReset: true, transcriptSince: undefined,
          timing: { logger: undefined, signal: expect.any(AbortSignal), generation: 1, viewId: 'v1' } });
      expect(broadcaster.flushTranscriptSeed).toHaveBeenCalledOnce();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(broadcaster.subscribe).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
    if (outcome === 'failure') expect(errors).toHaveBeenCalledWith('v1', expect.objectContaining({ message: 'restore failed' }));
    else expect(errors).not.toHaveBeenCalled();
    connection.dispose();
    expect(listenerDispose).toHaveBeenCalled();
  });

  it('discards a superseded cold generation even when its read ignores cancellation', async () => {
    let finishFirst!: (snapshot: AgentTranscriptSnapshot) => void;
    const readSignals: AbortSignal[] = [];
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdPageSnapshot: coldPageReader((_session, agent, signal: AbortSignal) => {
        readSignals.push(signal);
        if (agent === 'old-child') return new Promise((resolve) => { finishFirst = resolve; });
        return Promise.resolve({ ...new AgentTranscript(agent).snapshot(), toolCallCountKnown: true });
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const broadcaster = { getCursor: vi.fn(async () => ({ seq: 0, epoch: '' })), unsubscribe: vi.fn() };
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => ({ get: () => undefined }) } } as never, service: service as never });
    const attach = (generation: number, agentId: string) => connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 0 }, transcriptGrades: { [agentId]: 'delta' } },
    } });
    attach(1, 'old-child');
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    attach(2, 'new-child');
    expect(readSignals[0]?.aborted).toBe(true);
    finishFirst(new AgentTranscript('old-child').snapshot());
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready', generation: 2 }) })));
    expect(send.mock.calls.every(([frame]) => frame.data.generation === 2)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('starts a visible cold child without waiting for another visible agent history', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdPageSnapshot: coldPageReader(async (_sessionId, agentId) => {
        if (agentId === 'slow-child') await blocked;
        return { ...new AgentTranscript(agentId).snapshot(), toolCallCountKnown: true };
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const broadcaster = { getCursor: vi.fn(async () => ({ seq: 7, epoch: 'session-epoch' })), unsubscribe: vi.fn() };
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => ({ get: () => undefined }) } } as never, service: service as never });
    try {
      connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
        generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
        input: { sessionCursor: { seq: 7 }, transcriptGrades: { 'slow-child': 'delta', 'visible-child': 'delta' } },
      } });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'transcript', event: expect.objectContaining({ agent_id: 'visible-child' }),
      }) })));
      expect(send.mock.calls.some(([frame]) => frame.data.type === 'ready')).toBe(false);
      release();
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) })));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      connection.dispose();
    }
  });

  it('prioritizes cold explicit detail over earlier summary keys without acknowledging unfinished reads', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdPageSnapshot: coldPageReader(async (_sessionId, agentId) => {
        if (agentId === 'sibling') await blocked;
        return { ...new AgentTranscript(agentId).snapshot(), toolCallCountKnown: true };
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const broadcaster = { getCursor: vi.fn(async () => ({ seq: 7, epoch: 'session-epoch' })), unsubscribe: vi.fn() };
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors,
      { core: { accessor: { get: () => ({ get: () => undefined }) } } as never, service: service as never });
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7 }, transcriptGrades: { sibling: 'turn', 'visible-child': 'delta' } },
    } });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'transcript', event: expect.objectContaining({ agent_id: 'visible-child' }),
      }) })));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript']);
      expect(service.readColdPageSnapshot.mock.calls.map((call) => call[1])).toEqual(['visible-child', 'sibling']);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) })));
    expect(errors).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('delivers child activity before any transcript history has finished', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const broadcaster = {
      subscribe: vi.fn(async () => true), unsubscribe: vi.fn(),
      getBufferedSince: vi.fn(async () => ({ events: [], resyncRequired: false, currentSeq: 7, epoch: 'session-epoch' })),
      flushTranscriptSeed: vi.fn(async (_sessionId: string, target: SessionViewTarget) => {
        target.send({ ...durable(7), type: 'agent.status.updated', volatile: true,
          payload: { type: 'agent.status.updated', agentId: 'child', phase: { kind: 'running', turnId: 1 } } });
        await blocked;
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors);
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7, epoch: 'session-epoch' }, transcriptGrades: { main: 'delta' } },
    } });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'sessionCursorAdvanced', rosterAgentId: 'child',
      }) })));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['sessionCursorAdvanced']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      connection.dispose();
      release();
    }
  });

  it('delivers a short live main baseline while sibling history is pending and stops delivery on detach', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const snapshot: AgentTranscriptSnapshot = {
      ...new AgentTranscript('main').snapshot(), toolCallCountKnown: true,
      items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'Short conversation', steps: [] }],
    };
    const broadcaster = {
      subscribe: vi.fn(async () => true), unsubscribe: vi.fn(),
      getBufferedSince: vi.fn(async () => ({ events: [], resyncRequired: false, currentSeq: 7, epoch: 'session-epoch' })),
      flushTranscriptSeed: vi.fn(async (_sessionId: string, target: SessionViewTarget) => {
        target.send({ ...durable(7), type: 'transcript.reset', payload: {
          type: 'transcript.reset', session_id: 's1', agent_id: 'main', snapshot, grade: 'delta',
          cursor: { seq: 0, epoch: 'main-epoch' }, coverage: { kind: 'full', hasMoreOlder: false },
        } });
        await target.drain?.();
        await blocked;
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors);
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7, epoch: 'session-epoch' }, transcriptGrades: { main: 'delta', sibling: 'turn' } },
    } });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'transcript', event: expect.objectContaining({ agent_id: 'main', snapshot }),
      }) })));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript']);
      connection.receive({ type: 'view_detach', id: 'v1' });
    } finally {
      release();
      connection.dispose();
    }
    await vi.waitFor(() => expect(broadcaster.unsubscribe).toHaveBeenCalled());
    expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript']);
    expect(errors).not.toHaveBeenCalled();
  });

  it('opens a newly focused live child without waiting for the superseded seed and drops its late signals', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstTarget: SessionViewTarget | undefined;
    const broadcaster = {
      subscribe: vi.fn(async () => true), unsubscribe: vi.fn(),
      getBufferedSince: vi.fn(async () => ({ events: [], resyncRequired: false, currentSeq: 7, epoch: 'session-epoch' })),
      flushTranscriptSeed: vi.fn(async (_sessionId: string, target: SessionViewTarget) => {
        if (firstTarget === undefined) {
          firstTarget = target;
          await blocked;
          target.send(durable(99));
          await target.drain();
          return;
        }
        target.send({ ...durable(7), type: 'transcript.reset', payload: {
          type: 'transcript.reset', session_id: 's1', agent_id: 'visible-child',
          snapshot: new AgentTranscript('visible-child').snapshot(), grade: 'delta',
          cursor: { seq: 0, epoch: 'child-epoch' }, coverage: { kind: 'full', hasMoreOlder: false },
        } });
        await target.drain();
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors);
    const attach = (agentId: string) => connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7, epoch: 'session-epoch' }, transcriptGrades: { [agentId]: 'delta' } },
    } });
    try {
      attach('old-child');
      await vi.waitFor(() => expect(firstTarget).toBeDefined());
      attach('visible-child');
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) })));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript', 'ready']);
      expect(broadcaster.unsubscribe).toHaveBeenCalledWith('s1', firstTarget);
      release();
      await vi.waitFor(() => expect(broadcaster.unsubscribe).toHaveBeenCalledTimes(2));
      expect(send.mock.calls.map(([frame]) => frame.data.type)).toEqual(['transcript', 'ready']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      connection.dispose();
    }
  });

  it('keeps an in-flight seed when a re-attach only widens grades and applies the wider grades afterwards', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const seeded: string[][] = [];
    const broadcaster = {
      subscribe: vi.fn(async () => true), unsubscribe: vi.fn(),
      getBufferedSince: vi.fn(async () => ({ events: [], resyncRequired: false, currentSeq: 7, epoch: 'session-epoch' })),
      flushTranscriptSeed: vi.fn(async (_sessionId: string, target: SessionViewTarget) => {
        const grades = (broadcaster.subscribe.mock.calls.at(-1) as unknown as [string, SessionViewTarget, unknown, Record<string, string>])[3];
        seeded.push(Object.keys(grades).toSorted());
        if (seeded.length === 1) await blocked;
        await target.drain();
      }),
    };
    const send = vi.fn();
    const errors = vi.fn();
    const connection = new SessionViewHttpConnection(broadcaster as unknown as SessionEventBroadcaster, send, errors);
    const attach = (transcriptGrades: Record<string, string>) => connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
      generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
      input: { sessionCursor: { seq: 7, epoch: 'session-epoch' }, transcriptGrades },
    } });
    try {
      attach({ main: 'delta' });
      await vi.waitFor(() => expect(seeded).toHaveLength(1));
      attach({ main: 'delta', child: 'delta' });
      attach({ main: 'delta', child: 'delta', other: 'turn' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(broadcaster.unsubscribe).not.toHaveBeenCalled();
      expect(seeded).toHaveLength(1);
      release();
      await vi.waitFor(() => expect(seeded).toHaveLength(2));
      expect(seeded[1]).toEqual(['child', 'main', 'other']);
      await vi.waitFor(() => expect(send.mock.calls.filter(([frame]) => frame.data.type === 'ready')).toHaveLength(2));
      expect(broadcaster.unsubscribe).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      connection.dispose();
    }
  });

  it('streams child activity transitions after the first drain even at the same durable cursor', async () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    const activity = (kind: string) => ({ ...durable(12), type: 'agent.status.updated', volatile: true,
      payload: { type: 'agent.status.updated', agentId: 'child', phase: { kind, turnId: 1 } } });
    target.begin(1);
    target.send(activity('running'));
    await target.drain();
    target.send(activity('idle'));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.type === 'sessionCursorAdvanced' && signal.rosterAgentId === 'child')).toBe(true);
    target.send(activity('idle'));
    expect(signals).toHaveLength(2);
    target.finish({ seq: 12, epoch: 'session-epoch' }, false);
    expect(signals.at(-1)?.type).toBe('ready');
  });

  it('deduplicates across partial drains and resets recovery state for a new attachment', async () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(1);
    target.replay(durable(11));
    target.send(durable(11));
    await target.drain();
    expect(signals.map((signal) => signal.type)).toEqual(['sessionCursorAdvanced']);
    target.send(durable(11));
    target.send(durable(12));
    target.finish({ seq: 11, epoch: 'session-epoch' }, true);
    expect(signals).toEqual([
      { type: 'sessionCursorAdvanced', cursor: { seq: 11, epoch: 'session-epoch' }, generation: 1 },
      { type: 'sessionCursorAdvanced', cursor: { seq: 12, epoch: 'session-epoch' }, generation: 1 },
      { type: 'ready', currentSessionCursor: { seq: 12, epoch: 'session-epoch' }, reconnected: true, generation: 1 },
    ]);
    signals.length = 0;
    target.begin(2);
    target.send(durable(11));
    target.sendControl({ type: 'resync_required', payload: { reason: 'epoch_changed', current_seq: 0, epoch: 'new-epoch' } });
    await target.drain();
    target.finish({ seq: 0, epoch: 'new-epoch' }, true);
    expect(signals.map((signal) => signal.type)).toEqual(['resyncRequired']);
    target.begin(3);
    target.send(durable(11));
    await target.drain();
    expect(signals.at(-1)).toMatchObject({ type: 'sessionCursorAdvanced', generation: 3 });
  });

  it('publishes payload-free segmented cold attach timings only to diagnostic subscribers', async () => {
    const timing = channel('kiki.session-view.timing');
    const records: Array<Record<string, unknown>> = [];
    const collect = (message: unknown): void => { records.push(message as Record<string, unknown>); };
    timing.subscribe(collect);
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdPageSnapshot: coldPageReader(async () => ({ ...new AgentTranscript('child').snapshot(), toolCallCountKnown: true })),
    };
    const connection = new SessionViewHttpConnection({
      getCursor: async () => ({ seq: 7, epoch: 'session-epoch' }), unsubscribe: vi.fn(),
    } as unknown as SessionEventBroadcaster, vi.fn(), vi.fn(),
      { core: { accessor: { get: () => ({ get: () => undefined }) } } as never, service: service as never });
    try {
      connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: {
        generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION,
        input: { sessionCursor: { seq: 7 }, transcriptGrades: { child: 'delta' } },
      } });
      await vi.waitFor(() => expect(records.map((record) => record['stage'])).toEqual([
        'attach_queue', 'cold_roster', 'cold_agent_read', 'first_detail_reset', 'attach_cursor', 'attach_ready',
      ]));
      for (const record of records) {
        expect(record['durationMs']).toEqual(expect.any(Number));
        expect(Number(record['durationMs'])).toBeGreaterThanOrEqual(0);
        expect(record).toMatchObject({ sessionId: 's1', generation: 1, viewId: 'v1' });
        expect(Object.keys(record).every((key) => ['stage', 'outcome', 'signalAborted', 'durationMs', 'sessionId', 'agentId', 'generation', 'viewId'].includes(key))).toBe(true);
      }
      expect(records.filter((record) => record['outcome'] !== undefined).every((record) => record['outcome'] === 'succeeded')).toBe(true);
    } finally {
      connection.dispose();
      timing.unsubscribe(collect);
    }
  });

  it('keeps an unverified empty cold baseline unknown instead of certifying a blank session', async () => {
    const service = { reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot, readColdPageSnapshot: coldPageReader(async () => ({ ...new AgentTranscript('main').snapshot(), toolCallCountKnown: false })) };
    const event = await readColdSessionViewBaseline(service as never, 's1', 'main', 'delta', new AbortController().signal);
    expect(event).toMatchObject({ cursor: { seq: 0, epoch: 'cold:s1:main' }, coverage: { kind: 'unknown', hasMoreOlder: true } });
  });
});

it.each(['journal_gap', 'future_reason'])('blocks coverage acknowledgement after %s and recovers on a new generation', (reason) => {
  const signals: SessionViewSignal[] = [];
  const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
  target.begin(1);
  target.sendDurableCursor({ seq: 90, epoch: 'session-epoch' });
  target.sendControl({ type: 'resync_required', payload: { reason, current_seq: 100, epoch: 'session-epoch' } });
  target.finish({ seq: 100, epoch: 'session-epoch' }, true);
  target.send(durable(101));
  target.sendDurableCursor({ seq: 102, epoch: 'session-epoch' });
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject(reason === 'journal_gap' ? { type: 'resyncRequired', reason } : { type: 'protocolError', recoverable: true });
  target.begin(2);
  target.finish({ seq: 100, epoch: 'session-epoch' }, true);
  expect(signals[1]).toMatchObject({ type: 'ready', generation: 2, currentSessionCursor: { seq: 100 } });
});
