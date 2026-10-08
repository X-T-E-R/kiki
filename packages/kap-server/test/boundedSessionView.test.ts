import { describe, expect, it } from 'vitest';
import { AgentTranscript, applyContentSegment, jsonBytes, transcriptDetailListResponseSchema, type AgentTranscriptSnapshot, type TranscriptTask } from '@kiki/transcript';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { boundedEntity } from '../src/transport/klient/boundedContent';
import { boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
import { readSessionViewTranscriptCatchUp, readSessionViewTranscriptContent, readSessionViewTranscriptDetails, readSessionViewTranscriptPage } from '../src/transport/klient/sessionViewReads';

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
        v: 2, agentId: 'main', source: 'cold', anchor: `marker:${seen.at(-1)}`, epoch: 'cold:fixture-session:main',
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
});
