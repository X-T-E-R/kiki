import { channel } from 'node:diagnostics_channel';
import { describe, expect, it, vi } from 'vitest';
import type { SessionViewSignal } from '@kiki/klient';
import { AgentTranscript, TRANSCRIPT_COVERAGE_VERSION } from '@kiki/transcript';
import { SessionViewTarget } from '../src/transport/klient/sessionViewTarget';
import { SessionViewHttpConnection } from '../src/transport/klient/sessionViewHttp';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import { readColdSessionViewBaseline } from '../src/transport/klient/sessionViewReads';

function durable(seq: number) {
  return { type: 'turn.ended', session_id: 's1', seq, epoch: 'session-epoch', timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'turn.ended' } };
}

describe('SessionViewTarget', () => {
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

  it('preserves rewrite and epoch invalidation signals', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(2);
    target.replay({ ...durable(9), payload: { type: 'event.session.history_rewritten', reason: 'regenerate', target_message_id: 'message-1' } });
    target.sendControl({ type: 'resync_required', payload: { reason: 'epoch_changed', current_seq: 0, epoch: 'new-epoch' } });
    target.finish({ seq: 0, epoch: 'new-epoch' }, false);
    expect(signals).toEqual([{ type: 'resyncRequired', reason: 'epoch_changed', currentSessionCursor: { seq: 0, epoch: 'new-epoch' }, generation: 2 }]);
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
    let resolveRead: ((snapshot: unknown) => void) | undefined;
    let readSignal: AbortSignal | undefined;
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => Array.from({ length: 456 }, (_, i) => ({ agentId: `agent-${i}`, type: 'sub' }))),
      readColdSnapshot: vi.fn((_sessionId, _agentId, _query, signal: AbortSignal) => {
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
    resolveRead!({ ...new AgentTranscript('agent-27').snapshot(), toolCallCountKnown: true });
    await vi.waitFor(() => {
      if (detach) expect(readSignal?.aborted).toBe(true);
      else expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.readColdSnapshot).toHaveBeenCalledExactlyOnceWith('s1', 'agent-27', undefined, expect.any(AbortSignal));
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
      readColdSnapshot: vi.fn(async () => ({ ...new AgentTranscript('main').snapshot(), toolCallCountKnown: true })),
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
        { main: 'delta' }, { deferTranscriptReset: true, transcriptSince: undefined });
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
    let finishFirst!: (snapshot: unknown) => void;
    const readSignals: AbortSignal[] = [];
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdSnapshot: vi.fn((_session, agent, _query, signal: AbortSignal) => {
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

  it('prioritizes cold explicit detail over earlier summary keys without acknowledging unfinished reads', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdSnapshot: vi.fn(async (_sessionId, agentId) => {
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
      expect(service.readColdSnapshot.mock.calls.map((call) => call[1])).toEqual(['visible-child', 'sibling']);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'ready' }) })));
    expect(errors).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('publishes payload-free segmented cold attach timings only to diagnostic subscribers', async () => {
    const timing = channel('kiki.session-view.timing');
    const records: Array<Record<string, unknown>> = [];
    const collect = (message: unknown): void => { records.push(message as Record<string, unknown>); };
    timing.subscribe(collect);
    const service = {
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot,
      readColdRoster: vi.fn(async () => []),
      readColdSnapshot: vi.fn(async () => ({ ...new AgentTranscript('child').snapshot(), toolCallCountKnown: true })),
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
        'attach_queue', 'cold_agent_read', 'first_detail_reset', 'attach_ready',
      ]));
      for (const record of records) {
        expect(record['durationMs']).toEqual(expect.any(Number));
        expect(Number(record['durationMs'])).toBeGreaterThanOrEqual(0);
        expect(Object.keys(record).every((key) => ['stage', 'durationMs', 'sessionId', 'agentId', 'generation'].includes(key))).toBe(true);
      }
    } finally {
      connection.dispose();
      timing.unsubscribe(collect);
    }
  });

  it('keeps an unverified empty cold baseline unknown instead of certifying a blank session', async () => {
    const service = { reconcileQuestionSnapshot: (_sessionId: string, snapshot: unknown) => snapshot, readColdSnapshot: vi.fn(async () => ({ ...new AgentTranscript('main').snapshot(), toolCallCountKnown: false })) };
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
