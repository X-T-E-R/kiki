import { describe, expect, it } from 'vitest';
import { AgentTranscript, applyContentSegment, jsonBytes, transcriptDetailListResponseSchema, type AgentTranscriptSnapshot, type TranscriptTask } from '@kiki/transcript';
import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { boundedEntity } from '../src/transport/klient/boundedContent';
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
  it('continues a canonical older frame from cold history when the live tail has evicted it', async () => {
    const frame = { kind: 'text' as const, frameId: 'f-old', role: 'assistant' as const, text: '旧正文😀'.repeat(10_000) };
    const older: AgentTranscriptSnapshot = { ...empty(), items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's-old', turnId: 't0', ordinal: 0, state: 'completed', frames: [frame] }] }] };
    const service = canonicalService({ ...empty(), hasMoreOlder: true });
    service.readColdSnapshot = async () => older;
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
    const service = { forSessionLive: () => undefined, readColdSnapshot: async () => snapshot, readColdRoster: async () => [], reconcileQuestionSnapshot: (_sessionId: string, value: AgentTranscriptSnapshot) => value } as unknown as TranscriptService;
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
      if (cursor !== undefined) expect(cursor).toBe(`marker:${seen.at(-1)}`);
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
});
