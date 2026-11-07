import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { AgentTranscript, applyContentSegment, jsonBytes, TRANSCRIPT_COVERAGE_VERSION, transcriptDetailListResponseSchema, type AgentTranscriptSnapshot, type TranscriptStep, type TranscriptTask, type TranscriptTurn } from '@kiki/transcript';
import { sessionViewTranscriptPageInputSchema } from '@kiki/klient';
import { createKlient } from '@kiki/klient/http';
import { CanonicalEntityPreparingError } from '../src/services/history/historyCanonicalReader';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { registerSessionViewHttp } from '../src/transport/klient/sessionViewHttp';
import { registerTranscriptRoutes } from '../src/routes/transcript';
import { boundedEntity, readContentSegment } from '../src/transport/klient/boundedContent';
import { boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
import { readColdSessionViewBaseline, readSessionViewTranscriptCatchUp, readSessionViewTranscriptContent, readSessionViewTranscriptDetails, readSessionViewTranscriptPage } from '../src/transport/klient/sessionViewReads';

function canonicalService(snapshot: AgentTranscriptSnapshot): TranscriptService {
  const transcript = new AgentTranscript('main');
  transcript.apply([{ op: 'reset', agentId: 'main', snapshot }]);
  return {
    forSessionLive: () => ({ ensureAgent: () => transcript, getAgent: () => transcript }),
    whenReady: async () => {},
    ensureAgentHistory: async () => transcript,
    reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
  } as unknown as TranscriptService;
}

const empty = (): AgentTranscriptSnapshot => ({ items: [], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} });

describe('bounded session-view canonical reads', () => {
  it('keeps canonical one-turn preparation retryable over HTTP until the complete structure is available', async () => {
    const turn: TranscriptTurn = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'Saved opening', stepsPartial: true, steps: [] };
    const canonical = { ...turn, stepsPartial: undefined, steps: [{ kind: 'step' as const, stepId: 's0', turnId: 't0', ordinal: 0, state: 'completed' as const,
      frames: [{ kind: 'text' as const, frameId: 'f0', role: 'assistant' as const, text: 'Complete earlier answer' }] }] };
    const readCanonicalEntity = vi.fn().mockRejectedValueOnce(new CanonicalEntityPreparingError()).mockResolvedValue(canonical);
    const service = { forSessionLive: () => undefined, readColdPageSnapshot: async () => ({ ...empty(), items: [turn], hasMoreOlder: false }),
      readCanonicalEntity, readColdRoster: async () => [], reconcileQuestionSnapshot: (_session: string, snapshot: AgentTranscriptSnapshot) => snapshot } as unknown as TranscriptService;
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => reply.send({ code: 50001, msg: error instanceof Error ? error.message : String(error), data: null }));
    registerSessionViewHttp(app, {} as Scope, { sessionViewTranscriptService: service });
    const url = `/api/klient/session-view/fixture-session/transcript?agent_id=main&page_size=1&transcript_coverage_version=${TRANSCRIPT_COVERAGE_VERSION}`;
    try {
      const preparing = await app.inject({ method: 'GET', url });
      expect(preparing.json()).toMatchObject({ code: 40923, msg: 'history_canonical_preparing', data: null });
      const complete = (await app.inject({ method: 'GET', url })).json();
      expect(complete).toMatchObject({ code: 0, data: { items: [JSON.parse(JSON.stringify(canonical))] } });
      expect(complete.data.items[0].stepsPartial).toBeUndefined();
      expect(readCanonicalEntity).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it('seeks a requested newer one-turn preview after an older local window has reached source start', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' },
      prompt: `saved ${ordinal}`, startedAt: '2025-01-01T00:00:00.000Z', stepsPartial: true, steps: [] });
    const anchored = vi.fn(async () => ({ ...empty(), items: [turn(1), turn(2)], hasMoreOlder: true }));
    const service = { forSessionLive: () => undefined, readColdPageSnapshot: async () => ({ ...empty(), items: [turn(0)], hasMoreOlder: false }),
      readAnchoredColdSnapshot: anchored, anchorReadState: () => 'continues', readCanonicalEntity: async (_session: string, _agent: string, source: { id: string }) => ({ ...turn(Number(source.id.slice(1))), stepsPartial: undefined }),
      readColdRoster: async () => [], coldWindowReachedStart: async () => false, reconcileQuestionSnapshot: (_session: string, snapshot: AgentTranscriptSnapshot) => snapshot } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeTurn: 't2', pageSize: 1 });
    expect(anchored).toHaveBeenCalledWith('fixture-session', 'main', 't2', expect.any(AbortSignal));
    expect(page?.items).toContainEqual(expect.objectContaining({ turnId: 't1', prompt: 'saved 1' }));
  });

  it('reads a fresh cold-window structure ref before a stale retained canonical preview', async () => {
    const turn: TranscriptTurn = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: Array.from({ length: 20 }, (_, ordinal) => ({ kind: 'step', stepId: `s${ordinal}`, turnId: 't0', ordinal, state: 'completed', frames: [{ kind: 'text', frameId: `f${ordinal}`, role: 'assistant', text: `saved paragraph ${ordinal}` }] })) };
    const preview = boundedEntity(turn, { kind: 'turn', id: 't0' }, undefined, 'main', 'tail');
    const ref = preview.contentRefs!.find(ref => ref.path.length === 1)!;
    const stale = vi.fn(async () => ({ ...turn, steps: turn.steps.slice(10) }));
    const service = { forSessionLive: () => undefined, readColdWindowTurn: async () => turn, readCanonicalEntity: stale } as unknown as TranscriptService;
    const segment = await readSessionViewTranscriptContent(service, 'fixture-session', { agentId: 'main', ref });
    expect(segment?.value).toHaveLength(12);
    expect(applyContentSegment(preview, segment!).steps).toEqual(turn.steps);
    expect(stale).not.toHaveBeenCalled();
  });

  it('keeps captured older coverage after a concurrent reader replaces the retained cold window', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), hasMoreOlder: true, items: [{ kind: 'turn', turnId: 't20', ordinal: 20, state: 'completed', origin: { kind: 'user' }, prompt: 'saved body', steps: [] }] };
    const service = { forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(snapshot),
      coldHistoryTruncated: async () => false, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main' });
    expect(page?.has_more).toBe(true);
    expect(page?.next_cursor).toBeDefined();
  });

  it('returns a substantial older reading page without changing one-turn preview limits', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), items: Array.from({ length: 40 }, (_, ordinal) => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, prompt: 'reading body '.repeat(600), steps: [] })) };
    const service = { forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(snapshot),
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeTurn: 't40', pageSize: 40 });
    expect(page?.items).toHaveLength(40);
    expect(jsonBytes(page)).toBeGreaterThan(256 << 10);
    expect(jsonBytes(page)).toBeLessThan(512 << 10);
    expect(page?.items.filter(item => item.kind === 'turn').map(item => item.prompt)).toEqual(snapshot.items.filter(item => item.kind === 'turn').map(item => item.prompt));
  });

  it('loads up to 256 earlier structure entries within one bounded reading segment', async () => {
    const turn: TranscriptTurn = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: Array.from({ length: 300 }, (_, ordinal) => ({ kind: 'step', stepId: `s${ordinal}`, turnId: 't0', ordinal, state: 'completed', frames: [{ kind: 'text', frameId: `f${ordinal}`, role: 'assistant', text: `saved paragraph ${ordinal}` }] })) };
    const preview = boundedEntity(turn, { kind: 'turn', id: 't0' }, undefined, 'main', 'tail');
    const ref = preview.contentRefs!.find(ref => ref.path.length === 1)!;
    const service = canonicalService({ ...empty(), items: [turn] });
    const segment = await readSessionViewTranscriptContent(service, 'fixture-session', { agentId: 'main', ref });
    expect(segment?.value).toHaveLength(256);
    expect(segment?.start).toBe(36);
    expect(segment?.next?.offset).toBe(36);
    expect(jsonBytes(segment)).toBeLessThan(512 << 10);
    const next = applyContentSegment(preview, segment!);
    expect(next.steps.map(step => step.stepId)).toEqual(turn.steps.slice(36).map(step => step.stepId));
  });

  it('returns an unverified live page without waiting for the whole-wire proof', async () => {
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: { ...empty(), items: [
      { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: [] },
      { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [] },
    ], toolCallCountKnown: true } }]);
    const ensure = vi.fn(async () => transcript);
    const verify = vi.fn(() => new Promise<boolean>(() => {}));
    const service = { forSessionLive: () => ({ agents: () => [] }), ensureAgentHistory: ensure,
      verifyTranscriptLiveCoverage: verify, isTranscriptLiveCoverageVerified: () => false,
      getTranscriptCursor: () => ({ epoch: 'pending-proof', seq: 1 }) } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeTurn: 't1' });
    expect(page?.items).toMatchObject([{ turnId: 't0' }]);
    expect(page?.coverage.kind).toBe('unknown');
    expect(page?.tool_call_count).toBeUndefined();
    expect(ensure).toHaveBeenCalledWith('fixture-session', 'main', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled server read and aborts its underlying work without changing its input cursor', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = vi.fn(async (_session: string, _agent: string, _project: unknown, inputSignal: AbortSignal) => {
      signal = inputSignal;
      return new Promise<AgentTranscriptSnapshot>(() => {});
    });
    const service = { forSessionLive: () => undefined, readColdPageSnapshot: read } as unknown as TranscriptService;
    try {
      const outcome = readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'turn:t20' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatchObject({ code: 'session.busy', message: 'History page timed out. Retry to continue.' });
      expect(signal?.aborted).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('returns a valid item page before extending a window that would evict its anchor', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const ref = { kind: 'taskref' as const, refId: 'window-ref', taskId: 'example-task' };
    const window = { ...empty(), items: [turn(6), turn(7), ref, turn(8)], hasMoreOlder: true };
    let extended = false;
    const service = {
      forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => {
        if (extend) extended = true;
        return extend ? { ...empty(), items: [turn(4), turn(5)], hasMoreOlder: true } : window;
      },
      coldHistoryTruncated: async () => true, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'taskref:window-ref' });
    expect(page?.items).toEqual([turn(6), turn(7)]);
    expect(page?.has_more).toBe(true);
    expect(extended).toBe(false);
  });
  it.each(['turn', 'marker'] as const)('extends a consumed leading %s before seeking a replacement turn window', async (kind) => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const marker = { kind: 'marker' as const, markerId: 'delivery-before-next-turn', marker: 'message.delivery', payload: { text: 'recorded delivery' } };
    const boundary = kind === 'marker' ? [marker, turn(8)] : [turn(8)];
    const tail = { ...empty(), items: boundary, hasMoreOlder: true };
    const older = { ...empty(), items: [turn(6), turn(7), ...boundary], hasMoreOlder: false };
    const seeks: string[] = [];
    let extensions = 0;
    const service = {
      forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => {
        if (extend) extensions += 1;
        return extend ? older : tail;
      },
      readAnchoredColdSnapshot: async (_sessionId: string, _agentId: string, beforeTurn: string) => { seeks.push(beforeTurn); return { ...empty(), items: [turn(7), turn(8)], hasMoreOlder: true }; },
      anchorReadState: () => 'continues', coldHistoryTruncated: async () => false, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: kind === 'marker' ? `marker:${marker.markerId}` : 'turn:t8', seekTurn: 't8' })).toString('base64url');
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(page?.items).toEqual([turn(6), turn(7)]);
    expect(extensions).toBe(1);
    expect(seeks).toEqual([]);
  });

  it.each([true, false])('defers a recovered partial structure until the explicit one-turn read with has_more=%s', async (hasMore) => {
    const full: TranscriptTurn = { kind: 'turn', turnId: 't8', ordinal: 8, state: 'completed', origin: { kind: 'user' },
      prompt: 'saved opening', startedAt: '2025-01-01T00:00:00.000Z', steps: Array.from({ length: 52 }, (_, ordinal) => ({ kind: 'step',
        stepId: `s${ordinal}`, turnId: 't8', ordinal, state: 'completed', frames: [] })) };
    const opening = { ...full, stepsPartial: true, steps: full.steps.slice(0, 4) };
    const canonical = vi.fn(async () => full);
    const service = { forSessionLive: () => undefined, readCanonicalEntity: canonical,
      readColdPageSnapshot: async () => ({ ...empty(), items: [opening], hasMoreOlder: hasMore }),
      coldWindowReachedStart: async () => !hasMore, coldHistoryTruncated: async () => hasMore, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'turn:t8',
      beforeTurn: 't8', orphanTurn: 't8' })).toString('base64url');
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor, pageSize: 40 });
    expect(canonical).not.toHaveBeenCalled();
    expect(page?.items).toContainEqual(expect.objectContaining({ stepsPartial: true, steps: opening.steps }));
    expect(page?.has_more).toBe(hasMore);
    const expanded = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor, pageSize: 1 });
    const turn = expanded?.items.find((item): item is TranscriptTurn => item.kind === 'turn');
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(turn?.stepsPartial).toBeUndefined();
    expect(turn?.contentRefs).toContainEqual(expect.objectContaining({ path: ['steps'], total: 52 }));
    expect(expanded?.has_more).toBe(hasMore);
  });

  it('repairs a consumed orphan through canonical seek and continues through every earlier prompt to EOF', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed',
      origin: { kind: 'user' }, promptId: `p${ordinal}`, prompt: `Prompt ${ordinal}`, steps: [] });
    const orphan: TranscriptTurn = { kind: 'turn', turnId: 't8', ordinal: 8, state: 'completed', origin: { kind: 'other' }, steps: [] };
    const tail = { ...empty(), items: [orphan], hasMoreOlder: true };
    const seeks: string[] = [];
    let extensions = 0;
    const service = {
      forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => {
        if (extend) extensions += 1;
        return tail;
      },
      readAnchoredColdSnapshot: async (_sessionId: string, _agentId: string, beforeTurn: string) => {
        seeks.push(beforeTurn);
        return beforeTurn === 't8' ? { ...empty(), items: [turn(7), turn(8)], hasMoreOlder: true }
          : { ...empty(), items: [turn(6), turn(7)], hasMoreOlder: false };
      },
      anchorReadState: (snapshot: AgentTranscriptSnapshot) => snapshot.hasMoreOlder ? 'continues' : 'window',
      coldHistoryTruncated: async () => false, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'turn:t8',
      seekTurn: 't8', beforeTurn: 't8', orphanTurn: 't8' })).toString('base64url');
    const repaired = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(repaired?.items).toEqual([turn(8)]);
    expect(repaired?.has_more).toBe(true);
    expect(repaired?.next_cursor).not.toBe(cursor);
    const older = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: repaired!.next_cursor });
    expect(older?.items).toEqual([turn(7)]);
    expect(older?.has_more).toBe(true);
    expect(older?.next_cursor).not.toBe(repaired?.next_cursor);
    const first = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: older!.next_cursor });
    expect(first?.items).toEqual([turn(6)]);
    expect(first?.has_more).toBe(false);
    expect(first?.next_cursor).toBeUndefined();
    expect(seeks).toEqual(['t8', 't8', 't7']);
    expect(extensions).toBe(0);
  });

  it('continues a leading marker across byte progress without replacing it with a neighbouring turn seek', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const marker = { kind: 'marker' as const, markerId: 'delivery-boundary', marker: 'message.delivery', payload: { text: 'recorded delivery' } };
    const tail = { ...empty(), items: [marker, turn(8)], hasMoreOlder: true };
    const older = { ...empty(), items: [turn(7), marker, turn(8)], hasMoreOlder: false };
    let extensions = 0;
    let seeks = 0;
    const service = {
      forSessionLive: () => undefined,
      coldWindowBoundary: async () => ({ fingerprint: 'source', start: 100 - extensions, end: 200 }),
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => {
        if (extend) extensions += 1;
        return extensions >= 5 ? older : tail;
      },
      readAnchoredColdSnapshot: async () => { seeks += 1; return { ...empty(), items: [turn(7), turn(8)], hasMoreOlder: true }; },
      coldHistoryTruncated: async () => extensions < 5, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: `marker:${marker.markerId}`, seekTurn: 't8' })).toString('base64url');
    const preparing = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(preparing).toMatchObject({ items: [], has_more: true, read: { reason: 'budget' } });
    expect(extensions).toBe(4);
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: preparing!.next_cursor });
    expect(page?.items).toEqual([turn(7)]);
    expect(page?.has_more).toBe(false);
    expect(extensions).toBe(5);
    expect(seeks).toBe(0);
  });

  it.each([
    ['marker', 7, 't8'], ['marker', 8, 't7'], ['taskref', 7, 't7'], ['taskref', 8, 't8'],
  ] as const)('preserves delivered turns when a %s moves into turn %s with boundary %s', async (kind, ownerOrdinal, beforeTurn) => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const messageId = 'recorded-delivery';
    const boundaryItem = kind === 'marker'
      ? { kind: 'marker' as const, markerId: `message-delivery:${messageId}`, marker: 'message.delivery', payload: { text: 'recorded delivery' } }
      : { kind: 'taskref' as const, refId: 'recorded-task', taskId: 'example-task' };
    const anchor = kind === 'marker' ? `marker:message-delivery:${messageId}` : 'taskref:recorded-task';
    const tail = { ...empty(), items: [boundaryItem, turn(8)], hasMoreOlder: true };
    const owner: TranscriptTurn = { ...turn(ownerOrdinal), steps: [{ kind: 'step', stepId: 's-delivery', turnId: `t${ownerOrdinal}`, ordinal: 0, state: 'completed', frames: [{ kind: 'text', frameId: messageId, role: 'user', text: 'recorded delivery' }] }] };
    const older = { ...empty(), items: [turn(6), ownerOrdinal === 7 ? owner : turn(7), ownerOrdinal === 8 ? owner : turn(8)], hasMoreOlder: false };
    let extended = false;
    let seeks = 0;
    const service = {
      forSessionLive: () => undefined,
      coldWindowBoundary: async () => ({ fingerprint: 'unchanged-source', start: extended ? 50 : 100, end: 200 }),
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => { if (extend) extended = true; return extended ? older : tail; },
      readAnchoredColdSnapshot: async () => { seeks += 1; return tail; },
      coldHistoryTruncated: async () => false, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor, seekTurn: 't8', beforeTurn })).toString('base64url');
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(page?.items).toEqual(older.items.slice(0, beforeTurn === 't7' ? 1 : 2));
    expect(page?.has_more).toBe(false);
    expect(seeks).toBe(0);
  });

  it('retains a resolved turn boundary when prefix materialization needs another empty preparation page', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, promptId: `p${ordinal}`, steps: [] });
    const marker = { kind: 'marker' as const, markerId: 'materialized-boundary', marker: 'message.delivery' };
    let extensions = 0;
    const service = {
      forSessionLive: () => undefined,
      coldWindowBoundary: async () => ({ fingerprint: 'same-source', start: 100 - extensions, end: 200 }),
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, _project: unknown, _signal: unknown, extend: boolean) => {
        if (extend) extensions += 1;
        return { ...empty(), items: extensions === 0 ? [marker, turn(8)] : extensions < 5 ? [turn(8)] : [turn(7), turn(8)], hasMoreOlder: extensions < 5 };
      },
      coldHistoryTruncated: async () => extensions < 5, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'marker:materialized-boundary', seekTurn: 't8', beforeTurn: 't8' })).toString('base64url');
    const preparing = (await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor }))!;
    expect(preparing).toMatchObject({ items: [], has_more: true, read: { reason: 'budget' } });
    expect(JSON.parse(Buffer.from(preparing.next_cursor!, 'base64url').toString())).toMatchObject({ anchor: 'turn:t8', beforeTurn: 't8' });
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: preparing.next_cursor });
    expect(page?.items).toEqual([turn(7)]);
    expect(page?.has_more).toBe(false);
  });

  it.each(['unrelated', 'assistant', 'ambiguous'] as const)('does not resolve a delivery cursor from %s message identities', async (kind) => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [{
      kind: 'step', stepId: `s${ordinal}`, turnId: `t${ordinal}`, ordinal: 0, state: 'completed',
      frames: [{ kind: 'text', frameId: kind === 'unrelated' ? 'other-message' : 'recorded-delivery', role: kind === 'assistant' ? 'assistant' : 'user', text: 'same visible text' }],
    }] });
    const snapshot = { ...empty(), items: kind === 'ambiguous' ? [turn(7), turn(8)] : [turn(7)], hasMoreOlder: false };
    const service = { forSessionLive: () => undefined, readColdPageSnapshot: async () => snapshot } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'marker:message-delivery:recorded-delivery', seekTurn: 't8' })).toString('base64url');
    const stale = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(stale).toMatchObject({ items: [], has_more: true, read: { reason: 'stale_cursor', stale: { retry: 'authoritative' } } });
    expect(stale?.next_cursor).toBeUndefined();
  });

  it('yields an expensive orphan extension after committed progress and resumes at the same boundary', async () => {
    const orphan: TranscriptTurn = { kind: 'turn', turnId: 't8', ordinal: 8, state: 'completed', origin: { kind: 'other' }, steps: [] };
    const recovered: TranscriptTurn = { ...orphan, origin: { kind: 'user' }, prompt: 'saved opening', startedAt: '2026-01-01T00:00:00.000Z' };
    let elapsed = 0;
    let start = 10_000;
    let extensions = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const service = {
      forSessionLive: () => undefined,
      coldWindowBoundary: async () => ({ start, end: 20_000, fingerprint: 'same-source' }),
      readColdPageSnapshot: async (_session: string, _agent: string, project: (value: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, _signal: AbortSignal, extend: boolean) => {
        if (extend) { extensions += 1; start -= 1000; elapsed += 300; }
        return project({ ...empty(), items: [extensions >= 2 ? recovered : orphan], hasMoreOlder: true });
      },
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_session: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'turn:t8', beforeTurn: 't8', orphanTurn: 't8' })).toString('base64url');
    try {
      const pending = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor, pageSize: 40 });
      expect(extensions).toBe(1);
      expect(pending).toMatchObject({ items: [], has_more: true, read: { readiness: 'preparing' } });
      const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: pending?.next_cursor, pageSize: 40 });
      expect(extensions).toBe(2);
      expect(page?.items).toContainEqual(recovered);
      expect(start).toBe(8000);
    } finally { clock.mockRestore(); }
  });

  it('retains an orphan opening across a preparing marker cursor and delivers it before advancing', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, prompt: `Opening ${ordinal}`, steps: [] });
    const orphan: TranscriptTurn = { ...turn(8), origin: { kind: 'other' }, prompt: undefined };
    const marker = { kind: 'marker' as const, markerId: 'older-notification', marker: 'message.delivery' };
    const tail = { ...empty(), items: [marker, orphan], hasMoreOlder: true };
    const pending = { ...empty(), hasMoreOlder: true };
    const recovered = { ...empty(), items: [turn(7), turn(8)], hasMoreOlder: false };
    let seeks = 0;
    const service = {
      forSessionLive: () => undefined, readColdPageSnapshot: async () => seeks >= 2 ? recovered : tail,
      readAnchoredColdSnapshot: async () => ++seeks === 1 ? pending : recovered,
      anchorReadState: (snapshot: AgentTranscriptSnapshot) => snapshot === pending ? 'pending' : undefined,
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'marker:older-notification', seekTurn: 't8', beforeTurn: 't8', orphanTurn: 't8' })).toString('base64url');
    const preparing = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(preparing).toMatchObject({ items: [], has_more: true, read: { readiness: 'preparing' } });
    expect(JSON.parse(Buffer.from(preparing!.next_cursor!, 'base64url').toString())).toMatchObject({ orphanTurn: 't8' });
    const repaired = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: preparing!.next_cursor });
    expect(repaired?.items).toEqual([turn(8)]);
    expect(repaired?.next_cursor).toBeDefined();
  });

  it('keeps a pending item-anchor seek preparing even when turn headers cover its neighbourhood', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const ref = { kind: 'taskref' as const, refId: 'leading-ref', taskId: 'example-task' };
    const tail = { ...empty(), items: [ref, turn(7), turn(8)], hasMoreOlder: true };
    const pending = { ...empty(), hasMoreOlder: true };
    const recovered = { ...empty(), items: [turn(6), ref, turn(7)], hasMoreOlder: false };
    let seeks = 0;
    const service = {
      forSessionLive: () => undefined, readColdPageSnapshot: async () => tail,
      readAnchoredColdSnapshot: async () => ++seeks === 1 ? pending : recovered,
      anchorReadState: (snapshot: AgentTranscriptSnapshot) => snapshot === pending ? 'pending' : snapshot === recovered ? 'window' : undefined,
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'taskref:leading-ref', seekTurn: 't8' })).toString('base64url');
    const preparing = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(preparing).toMatchObject({ items: [], has_more: true, read: { readiness: 'preparing' } });
    const older = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: preparing!.next_cursor });
    expect(older?.items).toEqual([turn(6)]);
    expect(older?.has_more).toBe(false);
  });
  it('seeks a taskref boundary by its neighbouring turn without repeating the anchor', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const ref = { kind: 'taskref' as const, refId: 'task-ref', taskId: 'task-example' };
    const tail = { ...empty(), items: [ref, turn(8), turn(9)], hasMoreOlder: true };
    const older = { ...empty(), items: [turn(6), turn(7), ref, turn(8)], hasMoreOlder: false };
    const seeks: string[] = [];
    const service = {
      forSessionLive: () => undefined, readColdPageSnapshot: async () => tail,
      anchorReadState: (snapshot: AgentTranscriptSnapshot) => snapshot === tail ? 'continues' : 'window',
      readAnchoredColdSnapshot: async (_sessionId: string, _agentId: string, beforeTurn: string) => { seeks.push(beforeTurn); return older; },
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const first = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'turn:t9', pageSize: 20 });
    expect(first?.items).toEqual([ref, turn(8)]);
    expect(JSON.parse(Buffer.from(first!.next_cursor!, 'base64url').toString())).toMatchObject({ anchor: 'taskref:task-ref', seekTurn: 't8' });
    const next = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: first!.next_cursor, pageSize: 20 });
    expect(seeks).toEqual(['t8']);
    expect(next?.items).toEqual([turn(6), turn(7)]);
    expect(next?.has_more).toBe(false);
    expect(next?.next_cursor).toBeUndefined();
  });
  it('continues empty cold preparation through a same-anchor orphan repair and stops at unverified EOF', async () => {
    const orphan: TranscriptTurn = { kind: 'turn', turnId: 't7', ordinal: 7, state: 'completed', origin: { kind: 'other' },
      steps: [{ kind: 'step', stepId: 's7', turnId: 't7', ordinal: 1, state: 'completed', frames: [] }] };
    const repaired: TranscriptTurn = { ...orphan, origin: { kind: 'user' }, prompt: 'Recovered opening', promptId: 'p7', startedAt: '2026-01-01T00:00:00Z' };
    const earlier: TranscriptTurn = { kind: 'turn', turnId: 't6', ordinal: 6, state: 'completed', origin: { kind: 'user' }, prompt: 'Earlier opening', steps: [] };
    const windows: AgentTranscriptSnapshot[] = [
      { ...empty(), items: [orphan], hasMoreOlder: true, toolCallCountKnown: false },
      { ...empty(), items: [orphan], hasMoreOlder: true, toolCallCountKnown: false },
      { ...empty(), items: [repaired], hasMoreOlder: true, toolCallCountKnown: false },
      { ...empty(), items: [earlier, repaired], hasMoreOlder: false, toolCallCountKnown: false },
    ];
    let window = 0;
    const service = {
      forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, _signal?: AbortSignal, extend?: boolean) => {
        if (extend) window += 1;
        return project(windows[window]!);
      },
      coldHistoryTruncated: async () => windows[window]!.hasMoreOlder === true,
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: AgentTranscriptSnapshot) => snapshot,
    } as unknown as TranscriptService;
    const cursor = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'cold', anchor: 'turn:t7', epoch: 'cold:fixture-session:main' })).toString('base64url');
    const preparing = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: cursor });
    expect(preparing).toMatchObject({ items: [], has_more: true, next_cursor: cursor, read: { source: 'cold', readiness: 'partial' } });
    const repair = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: preparing!.next_cursor });
    expect(repair).toMatchObject({ items: [], has_more: true, next_cursor: cursor });
    const eof = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: repair!.next_cursor });
    expect(eof).toMatchObject({ items: [{ turnId: 't6' }], has_more: false, coverage: { kind: 'unknown' }, read: { readiness: 'partial' } });
    expect(eof!.next_cursor).toBeUndefined();
  });
  it('returns structured stale continuations when source-bound page and detail cursors change source', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true,
      items: [0, 1, 2].map((ordinal) => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] })),
      tasks: [0, 1, 2].map((ordinal) => ({ taskId: `task-${ordinal}`, kind: 'shell', state: 'completed', detached: false, outputTail: '' })),
    };
    const live = canonicalService(snapshot);
    Object.assign(live, { verifyTranscriptLiveCoverage: async () => true, isTranscriptLiveCoverageVerified: () => true,
      getTranscriptCursor: () => ({ seq: 3, epoch: 'live-epoch' }), forSessionLive: () => ({ agents: () => [] }) });
    const firstPage = await readSessionViewTranscriptPage(live, 'fixture-session', { agentId: 'main', pageSize: 1 });
    const firstDetail = await readSessionViewTranscriptDetails(live, 'fixture-session', { agentId: 'main', kind: 'task', limit: 1 });
    const cold = { forSessionLive: () => undefined, readColdSnapshot: async () => snapshot,
      readColdPageSnapshot: async () => snapshot, readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const pageCursor = encode({ v: 2, agentId: 'main', source: 'live', anchor: 'turn:t2', epoch: 'live-epoch' });
    const stalePage = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeItem: pageCursor });
    const staleDetail = await readSessionViewTranscriptDetails(cold, 'fixture-session', { agentId: 'main', kind: 'task', cursor: firstDetail?.next_cursor });
    const read = { source: 'cold', readiness: 'partial', reason: 'source_changed', stale: { reason: 'source_changed', retry: 'authoritative' } };
    expect(stalePage).toMatchObject({ items: [], has_more: true, coverage: { kind: 'unknown', hasMoreOlder: true }, read });
    expect(staleDetail).toMatchObject({ items: [], has_more: true, read });
    expect(stalePage?.next_cursor).toBeUndefined();
    expect(staleDetail?.next_cursor).toBeUndefined();
    expect(staleDetail?.total).toBeUndefined();
    expect(transcriptDetailListResponseSchema.safeParse(staleDetail).success).toBe(true);
    expect(JSON.parse(Buffer.from(firstPage!.next_cursor!, 'base64url').toString())).toMatchObject({ v: 2, source: 'live', agentId: 'main' });
    const recovered = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: 't2' });
    expect(recovered?.items).toHaveLength(2);
    expect(recovered?.read?.stale).toBeUndefined();
    const legacy = await readSessionViewTranscriptDetails(cold, 'fixture-session', { agentId: 'main', kind: 'task',
      cursor: encode({ v: 1, agentId: 'main', kind: 'task', after: 'task-0' }) });
    expect(legacy?.items).toMatchObject([{ taskId: 'task-1' }, { taskId: 'task-2' }]);
    await expect(readSessionViewTranscriptDetails(cold, 'fixture-session', { agentId: 'main', kind: 'task', cursor: 'invalid' })).rejects.toThrow('invalid transcript detail cursor');
  });
  it('drains a stable derived live-history cursor while preparing its cold source', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true,
      items: [0, 1, 2, 3].map((ordinal) => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] })),
    };
    const service = canonicalService({ ...snapshot, hasMoreOlder: true });
    Object.assign(service, {
      forSessionLive: () => ({ agents: () => [] }), verifyTranscriptLiveCoverage: async () => true,
      isTranscriptLiveCoverageVerified: () => true, getTranscriptCursor: () => ({ seq: 4, epoch: 'same-live-epoch' }),
      readColdPageSnapshot: async () => snapshot, readFullAgentSnapshot: async () => snapshot,
    });
    const first = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeTurn: 't3', pageSize: 1 });
    expect(first?.items).toMatchObject([{ turnId: 't2' }]);
    expect(first?.read?.source).toBe('derived');
    expect(first?.next_cursor).toBeDefined();
    const second = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: first!.next_cursor, pageSize: 1 });
    expect(second?.read?.stale).toBeUndefined();
    expect(second?.items).toMatchObject([{ turnId: 't1' }]);
    const last = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: second!.next_cursor, pageSize: 1 });
    expect(last?.items).toMatchObject([{ turnId: 't0' }]);
    expect(last?.has_more).toBe(false);
    const legacy = Buffer.from(JSON.stringify({ v: 2, agentId: 'main', source: 'derived', anchor: 'marker:old-boundary', seekTurn: 't2' })).toString('base64url');
    const stale = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: legacy });
    expect(stale).toMatchObject({ items: [], has_more: true, read: { source: 'derived', reason: 'stale_cursor', stale: { retry: 'authoritative' } } });
    const recovered = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeTurn: 't2' });
    expect(recovered?.items).toMatchObject([{ turnId: 't0' }, { turnId: 't1' }]);
  });

  it('continues a canonical older frame from cold history when the live tail has evicted it', async () => {
    const frame = { kind: 'text' as const, frameId: 'f-old', role: 'assistant' as const, text: '旧正文😀'.repeat(10_000) };
    const older: AgentTranscriptSnapshot = { ...empty(), items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's-old', turnId: 't0', ordinal: 0, state: 'completed', frames: [frame] }] }] };
    const service = canonicalService({ ...empty(), hasMoreOlder: true });
    service.readColdSnapshot = async () => older;
    service.readCanonicalEntity = async (_sessionId, agentId, source) => {
      if (agentId !== 'main') return undefined;
      const turn = older.items.find((item) => item.kind === 'turn' && item.turnId === (source.kind === 'turn' ? source.id : source.turnId));
      if (turn?.kind !== 'turn') return undefined;
      return source.kind === 'turn' ? turn : turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((item) => item.frameId === source.id);
    };
    let preview = boundedEntity(frame, { kind: 'frame', id: 'f-old', turnId: 't0', stepId: 's-old' });
    const deep = await readSessionViewTranscriptContent(service, 'fixture-session', { agentId: 'main', ref: { ...preview.contentRefs![0]!, source: { kind: 'turn', id: 't0' }, path: ['steps', 0, 'frames', 0, 'text'] } });
    expect(deep?.value).toBe(frame.text.slice(preview.text.length, preview.text.length + (deep?.value as string).length));
    while (preview.contentRefs?.length) {
      const segment = await readSessionViewTranscriptContent(service, 'fixture-session', { agentId: 'main', ref: preview.contentRefs[0]! });
      expect(segment).toBeDefined();
      preview = applyContentSegment(preview, segment!);
    }
    expect(preview.text).toBe(frame.text);
  });
  it('advances beforeTurn only from the final bounded page and inherits it through marker-only pages', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [turn(0), turn(1),
      ...Array.from({ length: 1500 }, (_, index) => ({ kind: 'marker' as const, markerId: `older-${index}`, marker: 'skill' as const, payload: { text: 'recorded body'.repeat(200) } })), turn(2)] };
    const service = { forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(snapshot),
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    let beforeItem: string | undefined;
    let boundary: string | undefined;
    const seen: string[] = [];
    let markerOnly = 0;
    do {
      const page = (await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem, pageSize: 20 }))!;
      expect(page.items.length).toBeGreaterThan(0);
      const delivered = page.items.filter(item => item.kind === 'turn');
      if (delivered.length === 0) markerOnly += 1;
      for (const item of delivered) if (boundary === undefined || item.ordinal < Number(boundary.slice(1))) boundary = item.turnId;
      seen.push(...page.items.map(item => item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId));
      beforeItem = page.next_cursor;
      if (beforeItem !== undefined) expect(JSON.parse(Buffer.from(beforeItem, 'base64url').toString()).beforeTurn).toBe(boundary);
    } while (beforeItem !== undefined);
    expect(markerOnly).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual(snapshot.items.map(item => item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId).sort());
  });

  it('keeps forward windows contiguous through decoded-budget cuts and marker-only pages', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [
      { kind: 'turn', turnId: 't0', ordinal: 0, origin: { kind: 'user' }, steps: [], state: 'completed' },
      { kind: 'turn', turnId: 't1', ordinal: 1, origin: { kind: 'user' }, steps: [], state: 'completed' },
      ...Array.from({ length: 220 }, (_, index) => ({ kind: 'marker' as const, markerId: `marker-${index}`, marker: 'skill' as const, payload: { text: '正文😀'.repeat(1000) } })),
    ] };
    const service = { forSessionLive: () => undefined, readColdSnapshot: async () => snapshot,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(snapshot),
      readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', ...(cursor === undefined ? { afterTurn: 't0' } : { afterItem: cursor }), pageSize: 100 }))!;
      expect(jsonBytes({ code: 0, msg: 'ok', data: page, request_id: 'fixture' })).toBeLessThan(88 * 1024);
      expect(page.coverage.kind).toBe('tail');
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((item) => item.kind === 'marker' ? item.markerId : item.kind === 'turn' ? item.turnId : item.taskId));
      cursor = page.next_cursor;
      expect(page.has_more).toBe(cursor !== undefined);
      if (cursor !== undefined) expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
        v: 2, agentId: 'main', source: 'cold', anchor: `marker:${seen.at(-1)}`, epoch: 'cold:fixture-session:main', seekTurn: 't2',
      });
    } while (cursor !== undefined);
    expect(seen).toEqual(['t1', ...Array.from({ length: 220 }, (_, index) => `marker-${index}`)]);
    await expect(readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', afterItem: 'marker:missing' })).rejects.toThrow('invalid transcript detail cursor');
  });
  it('pages catch-up at atomic batch boundaries within decoded bytes and offers a reset for an indivisible oversized batch', async () => {
    const tasks: TranscriptTask[] = Array.from({ length: 60 }, (_, index) => ({ taskId: `catch-${index}`, kind: 'shell', state: 'completed', detached: false, outputTail: '正文😀'.repeat(2000), command: 'command'.repeat(1000) }));
    const service = canonicalService({ ...empty(), tasks });
    const batches = Array.from({ length: 3 }, (_, index) => ({ seq: index + 1, ops: tasks.slice(index * 20, index * 20 + 20).map((task) => ({ op: 'task.upsert' as const, task })) }));
    service.getOpsSince = (_sessionId, _agentId, since) => ({ epoch: 'fixture-epoch', complete: true, throughSeq: 3, batches: batches.filter((batch) => batch.seq > (typeof since === 'number' ? since : since.seq)) });
    let since = { seq: 0, epoch: 'fixture-epoch' };
    const seen: number[] = [];
    let more: boolean;
    do {
      const page = (await readSessionViewTranscriptCatchUp(service, 'fixture-session', { agentId: 'main', since }))!;
      expect(jsonBytes(page)).toBeLessThan(48 * 1024);
      expect(page.complete).toBe(true);
      expect(page.through_seq).toBeGreaterThan(since.seq);
      seen.push(...page.batches.map((batch) => batch.seq));
      since = { seq: page.through_seq, epoch: page.epoch };
      more = page.has_more === true;
    } while (more);
    expect(seen).toEqual([1, 2, 3]);
    service.getOpsSince = () => ({ epoch: 'fixture-epoch', complete: true, throughSeq: 1, batches: [{ seq: 1, ops: tasks.map((task) => ({ op: 'task.upsert' as const, task })) }] });
    const reset = (await readSessionViewTranscriptCatchUp(service, 'fixture-session', { agentId: 'main', since: { seq: 0, epoch: 'fixture-epoch' } }))!;
    expect(reset.complete).toBe(false);
    expect(reset.batches).toEqual([]);
    expect(reset.has_more).toBe(false);
    expect(jsonBytes(reset)).toBeLessThan(48 * 1024);
  });
  it('pages every global task within the logical body budget and reads its exact original output', async () => {
    const body = '行😀\\\"\n'.repeat(20_000);
    const tasks: TranscriptTask[] = Array.from({ length: 100 }, (_, index) => ({ taskId: `task-${String(index).padStart(3, '0')}`, kind: 'shell', state: 'completed', detached: false, outputTail: body }));
    const service = canonicalService({ ...empty(), tasks });
    const ids: string[] = [];
    let cursor: string | undefined;
    let first: TranscriptTask | undefined;
    do {
      const page = await readSessionViewTranscriptDetails(service, 'fixture-session', { agentId: 'main', kind: 'task', limit: 100, cursor });
      expect(page?.kind).toBe('task');
      if (page?.kind !== 'task') throw new Error('Expected task page');
      expect(transcriptDetailListResponseSchema.safeParse(page).success).toBe(true);
      expect(jsonBytes({ code: 0, msg: 'ok', data: page, request_id: 'fixture' })).toBeLessThan(64 * 1024);
      expect(page.total).toBe(100);
      ids.push(...page.items.map((task) => task.taskId));
      first ??= page.items[0];
      cursor = page.next_cursor;
      expect(page.has_more).toBe(cursor !== undefined);
    } while (cursor !== undefined);
    expect(ids).toEqual(tasks.map((task) => task.taskId));
    if (first === undefined) throw new Error('Expected preview');
    let task = first;
    while (task.contentRefs?.length) {
      const segment = await readSessionViewTranscriptContent(service, 'fixture-session', { agentId: 'main', ref: task.contentRefs[0]! });
      if (segment === undefined) throw new Error('Missing canonical content');
      expect(jsonBytes(segment)).toBeLessThan(64 * 1024);
      task = applyContentSegment(task, segment);
    }
    expect(task.outputTail).toBe(body);
  });

  it('offers reachable interaction and todo collections and rejects a cursor from another agent', async () => {
    const service = canonicalService({ ...empty(), interactions: Array.from({ length: 25 }, (_, index) => ({ interactionId: `interaction-${index}`, interactionKind: 'question', state: 'answered', request: { question: `Question ${index}` } })), todos: [{ todoId: 'todos-main', items: [{ title: 'Complete fixture', status: 'in_progress' }] }] });
    const interactions = await readSessionViewTranscriptDetails(service, 'fixture-session', { agentId: 'main', kind: 'interaction', limit: 20 });
    expect(interactions?.total).toBe(25);
    expect(interactions?.has_more).toBe(true);
    expect(transcriptDetailListResponseSchema.safeParse(interactions).success).toBe(true);
    await expect(readSessionViewTranscriptDetails(service, 'fixture-session', { agentId: 'other-agent', kind: 'interaction', cursor: interactions?.next_cursor })).rejects.toThrow('invalid transcript detail cursor');
    const todos = await readSessionViewTranscriptDetails(service, 'fixture-session', { agentId: 'main', kind: 'todo' });
    expect(todos?.total).toBe(1);
    expect(todos?.has_more).toBe(false);
    expect(transcriptDetailListResponseSchema.safeParse(todos).success).toBe(true);
  });

  it('prioritizes the visible tail and old active prompt while keeping omitted prompts recoverable', async () => {
    const oldTurns = Array.from({ length: 10 }, (_, index) => ({
      kind: 'turn' as const, turnId: `old-turn-${index}`, ordinal: index, state: 'completed' as const,
      origin: { kind: 'user' as const }, promptId: `p-old-${index}`, prompt: 'old turn body '.repeat(1000), steps: [],
    }));
    const visibleTurn = { kind: 'turn' as const, turnId: 'visible-turn', ordinal: 10, state: 'completed' as const,
      origin: { kind: 'user' as const }, promptId: 'visible', prompt: 'newest visible turn', steps: [] };
    const prompts = [
      { promptId: 'p0', status: 'queued' as const, createdAt: '2026-01-01T00:00:00.000Z', content: 'queued prompt' },
      ...Array.from({ length: 10 }, (_, index) => ({ promptId: `p-old-${index}`, status: 'completed' as const, createdAt: '2026-01-01T00:00:01.000Z', content: `old prompt ${index}` })),
      { promptId: 'visible', status: 'completed' as const, createdAt: '2026-01-01T00:00:02.000Z', content: 'visible prompt' },
      ...Array.from({ length: 10 }, (_, index) => ({ promptId: `p-new-${index}`, status: 'completed' as const, createdAt: '2026-01-01T00:00:03.000Z', content: `new prompt ${index}` })),
    ];
    const source: AgentTranscriptSnapshot = { ...empty(), items: [...oldTurns, visibleTurn], prompts };
    const bounded = boundedTranscriptSnapshot(source, 'main', 'tail', 16 * 1024);
    expect(bounded.items).toEqual([expect.objectContaining({ turnId: 'visible-turn', promptId: 'visible' })]);
    expect(bounded.prompts.map((prompt) => prompt.promptId)).toEqual(expect.arrayContaining(['p0', 'visible']));
    expect(bounded.prompts.map((prompt) => prompt.promptId)).not.toContain('p-old-0');
    expect(bounded.prompts).toHaveLength(8);
    expect(jsonBytes(bounded.prompts)).toBeLessThanOrEqual(4 * 1024);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(16 * 1024);
    expect(bounded.globalCoverage?.prompts).toEqual({ returned: 8, total: 22, hasMore: true });

    const wide = boundedTranscriptSnapshot(source, 'main');
    expect(wide.items).toHaveLength(oldTurns.length + 1);
    expect(wide.prompts.map((prompt) => prompt.promptId)).toEqual(expect.arrayContaining(['p0', 'visible']));
    expect(wide.prompts.map((prompt) => prompt.promptId)).not.toContain('p-old-0');
    expect(wide.prompts).toHaveLength(8);
    expect(jsonBytes(wide.prompts)).toBeLessThanOrEqual(4 * 1024);

    const service = canonicalService(source);
    const recovered = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await readSessionViewTranscriptDetails(service, 'fixture-session', { agentId: 'main', kind: 'prompt', limit: 8, cursor });
      expect(page?.kind).toBe('prompt');
      if (page?.kind !== 'prompt') throw new Error('Expected prompt page');
      expect(transcriptDetailListResponseSchema.safeParse(page).success).toBe(true);
      expect(jsonBytes({ code: 0, msg: 'ok', data: page, request_id: 'fixture' })).toBeLessThan(48 * 1024);
      for (const prompt of page.items) recovered.set(prompt.promptId, String(prompt.content));
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    expect(recovered.size).toBe(prompts.length);
    expect(recovered.get('p0')).toBe('queued prompt');
    expect(recovered.get('p-old-0')).toBe('old prompt 0');
    expect(recovered.get('visible')).toBe('visible prompt');
  });

  it('uses tail structure windows for cold initial pages and baselines without changing explicit history pages', async () => {
    const turnFor = (turnId: string, ordinal: number): TranscriptTurn => ({
      kind: 'turn', turnId, ordinal, state: 'completed', origin: { kind: 'user' },
      steps: Array.from({ length: 12 }, (_, step) => ({
        kind: 'step' as const, turnId, stepId: `${turnId}-s${step}`, ordinal: step, state: 'completed' as const,
        frames: Array.from({ length: 12 }, (_, frame) => ({ kind: 'text' as const, frameId: `${turnId}-f${step}-${frame}`, role: 'assistant' as const, text: `saved-${turnId}-${step}-${frame}` })),
      })),
    });
    const source: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [turnFor('t0', 0), turnFor('t1', 1)] };
    const cold = {
      forSessionLive: () => undefined,
      readColdSnapshot: async () => source,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(source),
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const latest = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main' });
    const latestTurn = latest?.items.find((item) => item.kind === 'turn' && item.turnId === 't1');
    if (latestTurn?.kind !== 'turn') throw new Error('Expected latest turn');
    expect(latestTurn.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `t1-s${index + 4}`));
    expect(latestTurn.steps.at(-1)?.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `t1-f11-${index + 4}`));

    const baseline = await readColdSessionViewBaseline(cold, 'fixture-session', 'main', 'delta', new AbortController().signal);
    const baselineTurn = baseline?.snapshot.items.find((item) => item.kind === 'turn' && item.turnId === 't1');
    if (baselineTurn?.kind !== 'turn') throw new Error('Expected baseline turn');
    expect(baselineTurn.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `t1-s${index + 4}`));

    const history = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: 't1' });
    const historyTurn = history?.items.find((item) => item.kind === 'turn');
    if (historyTurn?.kind !== 'turn') throw new Error('Expected history turn');
    expect(historyTurn.turnId).toBe('t0');
    expect(historyTurn.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `t0-s${index}`));
    expect(historyTurn.steps[0]?.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `t0-f0-${index}`));

    const newer = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', afterTurn: 't0' });
    const newerTurn = newer?.items.find((item) => item.kind === 'turn');
    if (newerTurn?.kind !== 'turn') throw new Error('Expected newer turn');
    expect(newerTurn.turnId).toBe('t1');
    expect(newerTurn.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `t1-s${index}`));
    expect(newerTurn.steps[0]?.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `t1-f0-${index}`));
  });

  it.each(['before-turn', 'before-item', 'latest'] as const)('reloads one canonical tail preview for a single %s page and keeps history pages head-first', async (position) => {
    const step = (turnId: string, ordinal: number, stepId = `${turnId}-s${ordinal}`): TranscriptStep => ({
      kind: 'step' as const, turnId, stepId, ordinal, state: 'completed' as const,
      frames: [{ kind: 'text' as const, frameId: `${stepId}-f`, role: 'assistant' as const, text: `saved ${stepId}` }],
    });
    const turnFor = (turnId: string, ordinal: number, steps = Array.from({ length: 18 }, (_, index) => step(turnId, index))): TranscriptTurn => ({
      kind: 'turn', turnId, ordinal, state: 'completed', origin: { kind: 'user' }, prompt: `${turnId} prompt`, steps,
    });
    const stale = turnFor('t1', 1);
    const echoed = boundedEntity(stale, { kind: 'turn', id: 't1' }, undefined, 'main', 'tail');
    const staleRef = echoed.contentRefs?.find((ref) => ref.direction === 'backward' && ref.path.length === 1 && ref.path[0] === 'steps');
    if (staleRef === undefined) throw new Error('Expected stale backward steps ref');
    expect(staleRef.total - staleRef.offset).toBe(8);
    expect(staleRef.total).toBe(18);
    const canonical = turnFor('t1', 1, [step('t1', 0, 't1-replaced'), ...stale.steps.slice(1)]);
    expect(() => readContentSegment(canonical, staleRef)).toThrow('Content changed');
    const windowPreview = position === 'before-item' ? boundedEntity(stale, { kind: 'turn', id: 't1' }, undefined, 'main', 'head') : echoed;
    const source: AgentTranscriptSnapshot = {
      ...empty(), hasMoreOlder: false, items: position === 'latest' ? [turnFor('t0', 0), windowPreview] : [turnFor('t0', 0), windowPreview, turnFor('t2', 2, [])],
    };
    const cold = {
      forSessionLive: () => undefined,
      readColdSnapshot: async () => source,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(source),
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readCanonicalEntity: async (_sessionId: string, _agentId: string, source: { kind: string; id: string }) => {
        if (source.kind !== 'turn') return undefined;
        if (source.id === 't1') return canonical;
        if (source.id === 't0') return turnFor('t0', 0);
        return undefined;
      },
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: position === 'before-turn' ? 't2' : undefined,
      beforeItem: position === 'before-item' ? 'turn:t2' : undefined, pageSize: 1 });
    const turn = page?.items.find((item) => item.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('Expected canonical preview');
    expect(turn.turnId).toBe('t1');
    expect(turn.prompt).toBe('t1 prompt');
    const fresh = turn.contentRefs?.find((ref) => ref.direction === 'backward' && ref.path.length === 1 && ref.path[0] === 'steps');
    if (fresh === undefined) throw new Error('Expected fresh backward steps ref');
    expect(fresh.revision).not.toBe(staleRef.revision);
    expect(fresh.total).toBe(18);
    expect(fresh.total - fresh.offset).toBeLessThanOrEqual(8);
    expect(() => readContentSegment(canonical, fresh)).not.toThrow();
    expect(page?.has_more).toBe(true);
    expect(page?.coverage.kind).toBe('unknown');
    expect(page?.read?.stale).toBeUndefined();
    const eof = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: 't1', pageSize: 1 });
    expect(eof?.items.find((item) => item.kind === 'turn')).toMatchObject({ turnId: 't0' });
    expect(eof?.has_more).toBe(false);
    expect(eof?.next_cursor).toBeUndefined();
    expect(eof?.coverage.kind).not.toBe('full');
    const history = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: 't2' });
    const historyTurn = history?.items.find((item) => item.kind === 'turn' && item.turnId === 't0');
    if (historyTurn?.kind !== 'turn') throw new Error('Expected history turn');
    expect(historyTurn.steps.map((entry) => entry.stepId).slice(0, 2)).toEqual(['t0-s0', 't0-s1']);
    expect(historyTurn.contentRefs?.find((ref) => ref.path.length === 1 && ref.path[0] === 'steps')?.direction).not.toBe('backward');
  });

  it.each(['before-turn', 'before-item'] as const)('keeps a prompt-only %s preview on the cold-page source without canonical replay', async (position) => {
    const turn: TranscriptTurn = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' },
      promptId: 'prompt-zero', prompt: 'opening '.repeat(20_000), startedAt: '2025-01-01T00:00:00.000Z', steps: [] };
    const next: TranscriptTurn = { ...turn, turnId: 't1', ordinal: 1, promptId: 'prompt-one', prompt: 'next' };
    const source: AgentTranscriptSnapshot = { ...empty(), items: [turn, next] };
    const canonical = vi.fn(async () => turn);
    const cold = {
      forSessionLive: () => undefined,
      readColdSnapshot: async () => source,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(source),
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readCanonicalEntity: canonical,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', pageSize: 1,
      beforeTurn: position === 'before-turn' ? 't1' : undefined, beforeItem: position === 'before-item' ? 'turn:t1' : undefined });
    const preview = page?.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === 't0');
    expect(preview?.promptId).toBe('prompt-zero');
    expect(turn.prompt?.startsWith(preview?.prompt ?? '')).toBe(true);
    expect(preview?.contentRefs).toContainEqual(expect.objectContaining({ path: ['prompt'], kind: 'text' }));
    expect(canonical).not.toHaveBeenCalled();
  });

  it('still opens a legal oversized turn header on the single before-turn preview', async () => {
    const turn: TranscriptTurn = {
      kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'H'.repeat(180_000),
      steps: Array.from({ length: 18 }, (_, ordinal) => ({
        kind: 'step', turnId: 't0', stepId: `s${ordinal}`, ordinal, state: 'completed',
        frames: [{ kind: 'text', frameId: `f${ordinal}`, role: 'assistant', text: `saved ${ordinal}` }],
      })),
    };
    const next: TranscriptTurn = { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [] };
    const source: AgentTranscriptSnapshot = { ...empty(), items: [turn, next] };
    const cold = {
      forSessionLive: () => undefined,
      readColdSnapshot: async () => source,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(source),
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readCanonicalEntity: async () => turn,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeTurn: 't1', pageSize: 1 });
    const preview = page?.items.find((item) => item.kind === 'turn' && item.turnId === 't0');
    if (preview?.kind !== 'turn') throw new Error('Expected oversized header preview');
    expect(jsonBytes(preview)).toBeLessThan(160 * 1024);
    expect(preview.prompt?.length).toBeLessThan(turn.prompt!.length);
    const ref = preview.contentRefs?.find((entry) => entry.direction === 'backward' && entry.path[0] === 'steps');
    if (ref === undefined) throw new Error('Expected steps continuation');
    expect(() => readContentSegment(turn, ref)).not.toThrow();
    expect(page?.coverage.kind).not.toBe('full');
  });

  it('seeks an older turn across a disconnected header instead of stopping on that cursor', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const tail: AgentTranscriptSnapshot = { ...empty(), items: [turn(0), turn(90), turn(91)], hasMoreOlder: true, toolCallCountKnown: true };
    const middle: AgentTranscriptSnapshot = { ...empty(), items: Array.from({ length: 16 }, (_, index) => turn(30 + index)), hasMoreOlder: true, toolCallCountKnown: true };
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: tail }]);
    const sought: string[] = [];
    const service = {
      forSessionLive: () => ({ agents: () => [] }),
      ensureAgentHistory: async () => transcript,
      verifyTranscriptLiveCoverage: async () => false,
      isTranscriptLiveCoverageVerified: () => false,
      getTranscriptCursor: () => ({ seq: 1, epoch: 'gap-epoch' }),
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readColdPageSnapshot: async () => tail,
      readAnchoredColdSnapshot: async (_sessionId: string, _agentId: string, beforeTurn: string) => {
        sought.push(beforeTurn);
        return beforeTurn === 't40' ? middle : undefined;
      },
      readFullAgentSnapshot: async (_sessionId: string, _agentId: string, _transcript: AgentTranscript, _signal?: AbortSignal, _project?: unknown, _beforeTurn?: string, pageSource?: AgentTranscriptSnapshot) => pageSource ?? tail,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'turn:t40', pageSize: 20 });
    expect(sought).toEqual(['t40']);
    expect(page?.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual(Array.from({ length: 10 }, (_, index) => `t${30 + index}`));
    expect(page?.items.some((item) => item.kind === 'turn' && item.turnId === 't0')).toBe(false);
    expect(page?.has_more).toBe(true);
    const again = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: page!.next_cursor, pageSize: 20 });
    expect(again?.items).toEqual([]);
    expect(again?.has_more).toBe(true);
    expect(again?.read?.readiness).toBe('partial');
    expect(sought).toContain('t30');
  });

  it('keeps a contiguous cold window on its cursor without seeking backward', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const window: AgentTranscriptSnapshot = { ...empty(), items: [0, 1, 2, 3, 4, 5].map(turn), hasMoreOlder: true, toolCallCountKnown: true };
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: window }]);
    let sought = 0;
    const service = {
      forSessionLive: () => ({ agents: () => [] }),
      ensureAgentHistory: async () => transcript,
      verifyTranscriptLiveCoverage: async () => true,
      isTranscriptLiveCoverageVerified: () => true,
      getTranscriptCursor: () => ({ seq: 6, epoch: 'contiguous-epoch' }),
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readColdPageSnapshot: async () => window,
      readAnchoredColdSnapshot: async () => { sought += 1; return undefined; },
      readFullAgentSnapshot: async () => window,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'turn:t3', pageSize: 20 });
    expect(sought).toBe(0);
    expect(page?.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual(['t0', 't1', 't2']);
  });

  it('extends past a tail that does not yet contain an older marker cursor', async () => {
    const turn = (ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const marker = (markerId: string) => ({ kind: 'marker' as const, markerId, marker: 'compaction' as const });
    const stages: AgentTranscriptSnapshot[] = [
      { ...empty(), items: [turn(80), turn(81)], hasMoreOlder: true },
      { ...empty(), items: [turn(50), turn(80), turn(81)], hasMoreOlder: true },
      { ...empty(), items: [turn(10), marker('m-old'), turn(11), turn(50), turn(80), turn(81)], hasMoreOlder: true },
    ];
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: stages[0]! }]);
    let step = 0;
    const service = {
      forSessionLive: () => ({ agents: () => [] }),
      ensureAgentHistory: async () => transcript,
      verifyTranscriptLiveCoverage: async () => false,
      isTranscriptLiveCoverageVerified: () => false,
      getTranscriptCursor: () => ({ seq: 1, epoch: 'marker-epoch' }),
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot, _signal?: AbortSignal, extend?: boolean) => {
        if (extend) step += 1;
        return project(stages[Math.min(step, stages.length - 1)]!);
      },
      readFullAgentSnapshot: async (_sessionId: string, _agentId: string, _transcript: AgentTranscript, _signal?: AbortSignal, _project?: unknown, _beforeTurn?: string, pageSource?: AgentTranscriptSnapshot) => pageSource ?? stages[0]!,
    } as unknown as TranscriptService;
    const page = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'marker:m-old', pageSize: 20 });
    expect(step).toBeGreaterThanOrEqual(2);
    expect(page?.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.kind)).toEqual(['t10']);
    const next = await readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: page!.next_cursor, pageSize: 20 });
    expect(next?.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual([]);
    expect(next?.has_more).toBe(true);
  });

  it('pages a long item key through a cursor the page input accepts', async () => {
    const longId = `t${'x'.repeat(400)}`;
    const turn = (turnId: string, ordinal: number): TranscriptTurn => ({ kind: 'turn', turnId, ordinal, state: 'completed', origin: { kind: 'user' }, steps: [] });
    const source: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [turn('t0', 0), turn('t1', 1), turn(longId, 2), turn('t9', 9)] };
    const cold = {
      forSessionLive: () => undefined,
      readColdPageSnapshot: async (_sessionId: string, _agentId: string, project: (snapshot: AgentTranscriptSnapshot) => AgentTranscriptSnapshot) => project(source),
      readColdRoster: async () => [],
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
    } as unknown as TranscriptService;
    const first = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeItem: 'turn:t9', pageSize: 1 });
    expect(first?.items).toMatchObject([{ turnId: longId }]);
    expect(first?.next_cursor).toBeDefined();
    expect(first!.next_cursor!.length).toBeLessThanOrEqual(512);
    expect(sessionViewTranscriptPageInputSchema.safeParse({ agentId: 'main', beforeItem: first!.next_cursor }).success).toBe(true);
    const decoded = JSON.parse(Buffer.from(first!.next_cursor!, 'base64url').toString('utf8')) as { anchor: string };
    expect(decoded.anchor.startsWith('~')).toBe(true);
    expect(decoded.anchor).not.toContain(longId);
    const second = await readSessionViewTranscriptPage(cold, 'fixture-session', { agentId: 'main', beforeItem: first!.next_cursor, pageSize: 20 });
    expect(second?.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual(['t0', 't1']);
    expect(second?.has_more).toBe(false);
    const longMarkerId = `m-${'y'.repeat(2000)}`;
    const bounded = boundedTranscriptSnapshot({ ...empty(), hasMoreOlder: true, items: [{ kind: 'marker', markerId: longMarkerId, marker: 'compaction' }, turn('t9', 9)] }, 'main');
    expect(bounded.olderCursor).toBeDefined();
    expect(bounded.olderCursor!.length).toBeLessThanOrEqual(512);
    expect(bounded.olderCursor!.startsWith('~')).toBe(true);
    expect(bounded.olderCursor).not.toContain(longMarkerId);
  });

  it('rejects a digest cursor that matches nothing once history is complete', async () => {
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [
      { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: [] },
      { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [] },
    ] };
    const service = canonicalService(snapshot);
    Object.assign(service, {
      verifyTranscriptLiveCoverage: async () => true,
      isTranscriptLiveCoverageVerified: () => true,
      getTranscriptCursor: () => ({ seq: 2, epoch: 'complete-epoch' }),
      forSessionLive: () => ({ agents: () => [] }),
    });
    await expect(readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: `~${'ab'.repeat(32)}.11` })).rejects.toThrow('invalid transcript detail cursor');
    await expect(readSessionViewTranscriptPage(service, 'fixture-session', { agentId: 'main', beforeItem: 'marker:missing' })).rejects.toThrow('invalid transcript detail cursor');
  });

  it('consumes server-segmented Klient+KAP transcript responses above 1114112 bytes (short-ID multi-entity todo page and oversized skeleton) and continues their exact bodies', async () => {
    const fullNote = '长笔记段落😀'.repeat(10_000);
    const todos = Array.from({ length: 18 }, (_, index) => ({
      todoId: `todo-${String(index).padStart(2, '0')}`,
      items: Array.from({ length: 160 }, (_, itemIndex) => ({
        title: `任务项 ${index}-${itemIndex} ${'说明内容'.repeat(24)}`,
        status: (itemIndex % 3 === 0 ? 'done' : itemIndex % 3 === 1 ? 'in_progress' : 'pending') as 'done' | 'in_progress' | 'pending',
      })),
      notes: {
        goal: index === 0 ? fullNote : `目标 ${index}`,
        directives: `指令 ${index}`,
        decided: `决定 ${index}`,
        evidence: `证据 ${index}`,
        next: `下一步 ${index}`,
      },
      updatedAt: '2026-11-07T00:00:00.000Z',
    }));
    const fullText = '段落😀'.repeat(15_000);
    const skeletonTurn: TranscriptTurn = {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      prompt: fullText,
      steps: Array.from({ length: 8 }, (_, stepOrdinal) => ({
        kind: 'step' as const,
        stepId: `s${stepOrdinal}`,
        turnId: 't0',
        ordinal: stepOrdinal,
        state: 'completed' as const,
        frames: Array.from({ length: 8 }, (_, frameOrdinal) => ({
          kind: 'text' as const,
          frameId: `f-${stepOrdinal}-${frameOrdinal}-${stepOrdinal === 7 && frameOrdinal === 7 ? 'x'.repeat(1_200_000) : 'short'}`,
          role: 'assistant' as const,
          text: stepOrdinal === 7 && frameOrdinal === 7 ? fullText : `reply-${stepOrdinal}-${frameOrdinal}`,
        })),
      })),
    };
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: [skeletonTurn], todos };
    const service = canonicalService(snapshot);
    Object.assign(service, {
      forSessionLive: () => ({ ensureAgent: () => { const t = new AgentTranscript('main'); t.apply([{ op: 'reset', agentId: 'main', snapshot }]); return t; }, getAgent: () => { const t = new AgentTranscript('main'); t.apply([{ op: 'reset', agentId: 'main', snapshot }]); return t; }, agents: () => [] }),
      verifyTranscriptLiveCoverage: async () => true,
      isTranscriptLiveCoverageVerified: () => true,
      getTranscriptCursor: () => ({ seq: 1, epoch: 'oversized-header-epoch' }),
      readCanonicalEntity: async () => skeletonTurn,
    });
    const app = Fastify({ forceCloseConnections: true });
    registerSessionViewHttp(app, {} as Scope, { sessionViewTranscriptService: service });
    await app.register(async (api) => {
      registerTranscriptRoutes(api as unknown as Parameters<typeof registerTranscriptRoutes>[0], { core: {} as Scope, transcriptService: service });
    }, { prefix: '/api' });
    const endpoint = await app.listen({ port: 0, host: '127.0.0.1' });
    const klient = createKlient({ endpoint });
    try {
      const rawTodos = await fetch(`${endpoint}/api/sessions/fixture-session/transcript/details?agent_id=main&kind=todo&limit=18`);
      expect(rawTodos.status).toBe(200);
      const rawTodosText = await rawTodos.text();
      expect(Buffer.byteLength(rawTodosText, 'utf8')).toBeGreaterThan(940 * 1024);
      expect(Buffer.byteLength(rawTodosText, 'utf8')).toBeLessThan(1024 * 1024 + 64 * 1024);

      const todoPage = await klient.session('fixture-session').view.transcript.entities!({ agentId: 'main', kind: 'todo', limit: 18 });
      if (todoPage.kind !== 'todo') throw new Error('Expected todo page');
      expect(todoPage.items.length).toBeGreaterThan(1);
      let firstTodo = todoPage.items[0]!;
      expect(firstTodo.todoId).toBe('todo-00');
      expect(firstTodo.notes?.goal?.length).toBeLessThan(fullNote.length);
      while (firstTodo.contentRefs?.length) {
        const segment = await klient.session('fixture-session').view.transcript.content!({ agentId: 'main', ref: firstTodo.contentRefs[0]! });
        firstTodo = applyContentSegment(firstTodo, segment);
      }
      expect(firstTodo.notes?.goal).toBe(fullNote);
      expect(firstTodo.items).toHaveLength(160);

      const raw = await fetch(`${endpoint}/api/klient/session-view/fixture-session/transcript?agent_id=main&page_size=1&transcript_coverage_version=${TRANSCRIPT_COVERAGE_VERSION}`);
      expect(raw.status).toBe(200);
      const rawText = await raw.text();
      expect(Buffer.byteLength(rawText, 'utf8')).toBeGreaterThan(1024 * 1024 + 64 * 1024);

      const page = await klient.session('fixture-session').view.transcript.page({ agentId: 'main', pageSize: 1 });
      let current = page.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === 't0')!;
      expect(current).toBeDefined();
      expect(current.prompt!.length).toBeLessThan(fullText.length);
      while (current.contentRefs?.length) {
        const segment = await klient.session('fixture-session').view.transcript.content!({ agentId: 'main', ref: current.contentRefs[0]! });
        current = applyContentSegment(current, segment);
      }
      expect(current.prompt).toBe(fullText);
      let lastFrame = current.steps.at(-1)!.frames.at(-1)!;
      if (lastFrame.kind !== 'text') throw new Error('Expected text frame');
      while (lastFrame.contentRefs?.length) {
        const segment = await klient.session('fixture-session').view.transcript.content!({ agentId: 'main', ref: lastFrame.contentRefs[0]! });
        lastFrame = applyContentSegment(lastFrame, segment);
      }
      expect(lastFrame.text).toBe(fullText);
    } finally {
      await klient.close();
      await app.close();
    }
  });

  it('pages user-messages and plans above 1114112 bytes without assembling the full list response', async () => {
    const userTexts = Array.from({ length: 4 }, (_, index) => `${'m'.repeat(400_000)}ENDMARK-user-${index}`);
    const singleUser = `${'u'.repeat(1_200_000)}ENDMARK-single-user`;
    const planTexts = Array.from({ length: 4 }, (_, index) => `${'p'.repeat(400_000)}ENDMARK-plan-${index}`);
    const singlePlan = `${'q'.repeat(1_200_000)}ENDMARK-single-plan`;
    const planBody = (text: string) => ({ kind: 'plan_review', plan: text, path: '/tmp/plan.md' });
    const turns: TranscriptTurn[] = [
      ...userTexts.map((prompt, index): TranscriptTurn => ({
        kind: 'turn', turnId: `t${index}`, ordinal: index, state: 'completed', origin: { kind: 'user' }, prompt, steps: [],
      })),
      { kind: 'turn', turnId: 't4', ordinal: 4, state: 'completed', origin: { kind: 'user' }, prompt: singleUser, steps: [] },
      ...planTexts.map((plan, index): TranscriptTurn => ({
        kind: 'turn', turnId: `t${index + 5}`, ordinal: index + 5, state: 'completed', origin: { kind: 'user' }, prompt: `plan ${index}`,
        steps: [{ kind: 'step', stepId: `s${index}`, turnId: `t${index + 5}`, ordinal: 0, state: 'completed', frames: [{
          kind: 'tool', frameId: `frame-${index}`, toolCallId: `call_plan_${index}`, name: 'ExitPlanMode', state: 'done',
          display: planBody(plan),
          output: `Plan saved to: /tmp/plan.md\n\n## Approved Plan:\n${plan}`,
        }] }],
      })),
      { kind: 'turn', turnId: 't9', ordinal: 9, state: 'completed', origin: { kind: 'user' }, prompt: 'single plan',
        steps: [{ kind: 'step', stepId: 's-single', turnId: 't9', ordinal: 0, state: 'completed', frames: [{
          kind: 'tool', frameId: 'frame-single', toolCallId: 'call_plan_single', name: 'ExitPlanMode', state: 'done',
          display: planBody(singlePlan),
          output: `Plan saved to: /tmp/plan.md\n\n## Approved Plan:\n${singlePlan}`,
        }] }] },
    ];
    const interactions = [
      ...planTexts.map((plan, index) => ({
        interactionId: `apr-${index}`, interactionKind: 'approval' as const, toolCallId: `call_plan_${index}`, state: 'approved' as const,
        request: { display: planBody(plan) }, response: { decision: 'approved', selectedLabel: 'Go' },
      })),
      {
        interactionId: 'apr-single', interactionKind: 'approval' as const, toolCallId: 'call_plan_single', state: 'approved' as const,
        request: { display: planBody(singlePlan) }, response: { decision: 'approved', selectedLabel: 'Go' },
      },
    ];
    const snapshot: AgentTranscriptSnapshot = { ...empty(), toolCallCountKnown: true, items: turns, interactions };
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot }]);
    const readFullAgentSnapshot = vi.fn();
    const readColdSnapshot = vi.fn();
    const service = {
      forSessionLive: () => ({
        ensureAgent: () => transcript,
        getAgent: () => transcript,
        agents: () => [{ agentId: 'main', type: 'main' as const }],
      }),
      whenReady: async () => {},
      ensureAgentHistory: async () => transcript,
      reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value,
      verifyTranscriptLiveCoverage: async () => true,
      isTranscriptLiveCoverageVerified: () => true,
      getTranscriptCursor: () => ({ seq: 1, epoch: 'listed-epoch' }),
      readFullAgentSnapshot,
      readColdSnapshot,
    } as unknown as TranscriptService;
    const app = Fastify({ forceCloseConnections: true });
    registerSessionViewHttp(app, {} as Scope, { sessionViewTranscriptService: service });
    await app.register(async (api) => {
      registerTranscriptRoutes(api as unknown as Parameters<typeof registerTranscriptRoutes>[0], { core: {} as Scope, transcriptService: service });
    }, { prefix: '/api' });
    const endpoint = await app.listen({ port: 0, host: '127.0.0.1' });
    const klient = createKlient({ endpoint });
    try {
      const rawUsers = await fetch(`${endpoint}/api/sessions/fixture-session/transcript/user-messages?agent_id=main`);
      expect(rawUsers.status).toBe(200);
      const rawUserText = await rawUsers.text();
      expect(Buffer.byteLength(rawUserText, 'utf8')).toBeLessThan(256 * 1024);
      expect(rawUserText).not.toContain('ENDMARK-user-0');
      expect(rawUserText).not.toContain('ENDMARK-single-user');
      const users = await klient.session('fixture-session').view.userMessages!({ agentId: 'main' });
      expect(users.agents[0]?.messages.map((message) => message.prompt)).toEqual([
        ...userTexts,
        singleUser,
        ...planTexts.map((_, index) => `plan ${index}`),
        'single plan',
      ]);
      expect(singleUser.length).toBeGreaterThan(1_114_112);
      expect(userTexts.join('').length + singleUser.length).toBeGreaterThan(1_114_112);

      const rawPlans = await fetch(`${endpoint}/api/sessions/fixture-session/transcript/plan?agent_id=main`);
      expect(rawPlans.status).toBe(200);
      const rawPlanText = await rawPlans.text();
      expect(Buffer.byteLength(rawPlanText, 'utf8')).toBeLessThan(256 * 1024);
      expect(rawPlanText).not.toContain('ENDMARK-plan-0');
      expect(rawPlanText).not.toContain('ENDMARK-single-plan');
      const plans = await klient.session('fixture-session').view.plans!({ agentId: 'main' });
      expect(plans.plans.map((plan) => plan.plan)).toEqual([...planTexts, singlePlan]);
      expect(plans.plans.every((plan) => plan.source === 'interaction')).toBe(true);
      expect(singlePlan.length).toBeGreaterThan(1_114_112);
      expect(readFullAgentSnapshot).not.toHaveBeenCalled();
      expect(readColdSnapshot).not.toHaveBeenCalled();
    } finally {
      await klient.close();
      await app.close();
    }
  });
});
