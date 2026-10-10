import { describe, expect, it, vi } from 'vitest';

import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { SessionViewFacade, SessionViewSignal, SessionViewTranscriptDetail } from '@kiki/klient/session-view';
import type { AgentTranscriptSnapshot, TranscriptTask } from '@kiki/transcript';

import type { SessionTransport } from '../transport';
import { SessionController } from './sessionController';
import type { ShellBlock, UserBlock } from './transcript';
import { transcriptDetailKey } from './transcript';
import { emptySnapshot, FIXED_AT, opsEvent, resetEvent } from './__fixtures__/canonicalTranscript';

const session = {
  id: 'session_test', workspace_id: 'wd_test_000000000000', title: 'Test',
  created_at: FIXED_AT, updated_at: FIXED_AT, busy: false,
  metadata: { cwd: 'C:/tmp' }, agent_config: { model: '' },
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
  permission_rules: [], message_count: 0, last_seq: 0,
} as unknown as SessionSnapshotResponse['session'];

const shellTask = (outputTail: string, truncated: boolean): TranscriptTask => ({
  taskId: 'task-shell', kind: 'shell', state: 'completed', detached: false, outputTail, startedAt: FIXED_AT,
  ...(truncated ? { detailRef: { kind: 'task' as const, taskId: 'task-shell' } } : {}),
});

function windowed(overrides: Partial<AgentTranscriptSnapshot> = {}): AgentTranscriptSnapshot {
  return emptySnapshot({
    items: [{ kind: 'taskref', refId: 'ref-shell', taskId: 'task-shell', at: FIXED_AT }] as AgentTranscriptSnapshot['items'],
    tasks: [shellTask('…tail line', true)],
    globalCoverage: {
      version: 1,
      tasks: { returned: 64, total: 70, hasMore: true },
      attachments: { returned: 0, total: 0, hasMore: false },
      prompts: { returned: 1, total: 1, hasMore: false },
    },
    ...overrides,
  });
}

function harness(detail: SessionViewFacade['transcript']['detail'], content?: SessionViewFacade['transcript']['content'], entities?: SessionViewFacade['transcript']['entities']) {
  let signal: ((value: SessionViewSignal) => void) | undefined;
  const view = {
    snapshot: vi.fn(async () => ({ as_of_seq: 1, epoch: 'e', session, in_flight_turn: null }) as unknown as SessionSnapshotResponse),
    transcript: { page: vi.fn(), catchUp: vi.fn(), detail, content, entities },
    subscribe: (_input: unknown, onSignal: (value: SessionViewSignal) => void) => {
      signal = onSignal;
      return { updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} };
    },
  } as unknown as SessionViewFacade;
  const scheduler = { schedule: (callback: () => void) => { callback(); return 0; }, cancel: () => {} };
  const controller = new SessionController({} as SessionTransport, view, 'session_test', { scheduler });
  const deliver = (event: Parameters<SessionController['handleTranscript']>[0]) => {
    signal!({ type: 'transcript', event, generation: 1 });
  };
  const publish = (event: Parameters<SessionController['handleTranscript']>[0]) => {
    deliver(event);
    controller.flushFrames();
  };
  return { controller, deliver, publish, view };
}

const shellOf = (controller: SessionController) =>
  controller.getState().blocks.find((block): block is ShellBlock => block.kind === 'shell');

function taskDetail(outputTail: string): SessionViewTranscriptDetail {
  return { session_id: 'session_test', agent_id: 'main', kind: 'task', task: shellTask(outputTail, false) } as SessionViewTranscriptDetail;
}

describe('SessionController transcript detail', () => {
  it.each(['main', 'child'] as const)('binds %s todo provenance to adopted notes in both page/live orders (SOL-02)', async (agentId) => {
    const meta = (rev: number) => ({ rev, hash: `notes-${rev}`, writtenTurn: 1, writtenStep: 't1.1', coveredMessageId: '', windowEpoch: 0 });
    const partial = { source: 'derived' as const, readiness: 'partial' as const, reason: 'source_unverified' as const,
      watermark: { transcript: { seq: 4, epoch: 'epoch-canonical' } } };
    let resolvePage!: (page: Awaited<ReturnType<NonNullable<SessionViewFacade['transcript']['entities']>>>) => void;
    const page = { session_id: 'session_test', agent_id: agentId, kind: 'todo' as const,
      items: [{ todoId: 'todo', items: [], notes: { goal: 'Partial four' }, notesMeta: meta(4) }], has_more: false, read: partial };
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>(() => new Promise((resolve) => { resolvePage = resolve; }));
    const { controller, publish: deliver } = harness(undefined, undefined, entities);
    await controller.open();
    if (agentId === 'child') controller.retainAgentView('notes-child', agentId, 'delta');
    const state = () => agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
    const live = { todoId: 'todo', items: [], notes: { goal: 'Complete five' }, notesMeta: meta(5) };
    try {
      deliver(resetEvent(agentId, emptySnapshot(), 2));
      const late = controller.loadTranscriptEntities(agentId, 'todo');
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: live }], 5));
      resolvePage(page);
      await late;
      expect(state().todoNotesMeta?.rev).toBe(5);
      expect(state().todoRead).toMatchObject({ source: 'live', readiness: 'ready', watermark: { transcript: { seq: 5 } } });
      deliver(resetEvent(agentId, emptySnapshot(), 6));
      const first = controller.loadTranscriptEntities(agentId, 'todo');
      resolvePage(page);
      await first;
      expect(state().todoRead).toEqual(partial);
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: live }], 7));
      expect(state().todoNotes).toEqual(live.notes);
      expect(state().todoRead).toMatchObject({ source: 'live', readiness: 'ready', watermark: { transcript: { seq: 7 } } });
      expect((agentId === 'main' ? controller.getAgentState('child') : controller.getState()).todoRead).toBeUndefined();
    } finally { controller.close(); }
  });

  it.each(['main', 'child'] as const)('does not promote %s incomplete or non-advancing canonical notes (SOL-02)', async (agentId) => {
    const meta = (rev: number) => ({ rev, hash: `notes-${rev}`, writtenTurn: 1, writtenStep: 't1.1', coveredMessageId: '', windowEpoch: 0 });
    const read = { source: 'derived' as const, readiness: 'partial' as const, reason: 'source_unverified' as const,
      watermark: { transcript: { seq: 10, epoch: 'epoch-canonical' } } };
    const initial = { todoId: 'todo', items: [], notes: { goal: 'Partial four' }, notesMeta: meta(4) };
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>(async () => ({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [initial], has_more: false, read }));
    const { controller, publish: deliver } = harness(undefined, undefined, entities);
    await controller.open();
    if (agentId === 'child') controller.retainAgentView('notes-child', agentId, 'delta');
    const state = () => agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
    try {
      deliver(resetEvent(agentId, emptySnapshot(), 2));
      await controller.loadTranscriptEntities(agentId, 'todo');
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { ...initial, items: [{ title: 'Checklist only', status: 'done' }] } }], 3));
      expect(state().todoRead).toEqual(read);
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { ...initial, notesMeta: meta(5) } }], 9));
      expect(state().todoRead).toEqual(read);
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { todoId: 'todo', items: [], notesMeta: meta(6) } }], 11));
      expect(state().todoRead?.readiness).toBe('partial');
      const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'todo', id: 'todo' }, revision: 'notes-7', path: ['notes', 'goal'], kind: 'text', offset: 4, total: 20 };
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { ...initial, notesMeta: meta(7), contentRefs: [ref] } }], 12));
      expect(state().todoRead?.readiness).toBe('partial');
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { ...initial, notesMeta: meta(8), notesStatus: { state: 'incompatible', wireOrdinal: 13, schemaVersion: 1, fields: ['notes'] } } }], 13));
      expect(state().todoRead?.readiness).toBe('partial');
      deliver(opsEvent(agentId, [{ op: 'todo.upsert', todo: { ...initial, notesMeta: meta(9) } }], 14));
      expect(state().todoRead).toMatchObject({ readiness: 'ready', watermark: { transcript: { seq: 14 } } });
    } finally { controller.close(); }
  });

  it.each(['main', 'child'] as const)('adopts only %s newer verified todo entity pages (NP-PAGE-INSERT)', async (agentId) => {
    const meta = (rev: number) => ({ rev, hash: `notes-${rev}`, writtenTurn: 1, writtenStep: 't1.1', coveredMessageId: '', windowEpoch: 0 });
    const initial = { todoId: 'todo', items: [], notes: { goal: 'Saved five' }, notesMeta: meta(5) };
    const fresh = { ...initial, notes: { goal: 'Verified six' }, notesMeta: meta(6) };
    const ready = { source: 'live' as const, readiness: 'ready' as const, watermark: { transcript: { seq: 5, epoch: 'epoch-canonical' } } };
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>();
    const { controller, deliver } = harness(undefined, undefined, entities);
    await controller.open();
    if (agentId === 'child') controller.retainAgentView('notes-child', agentId, 'delta');
    const state = () => agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
    try {
      for (let index = 0; index < 4; index += 1) {
        const seq = 5 + index;
        const verified = { ...ready, watermark: { transcript: { seq, epoch: 'epoch-canonical' } } };
        const read = [undefined, { ...verified, readiness: 'partial' as const }, { ...verified, watermark: { transcript: { seq: seq - 1, epoch: 'epoch-canonical' } } }, verified][index];
        deliver(resetEvent(agentId, emptySnapshot({ todos: [initial] }), seq));
        entities.mockResolvedValueOnce({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [fresh], has_more: false, read });
        await controller.loadTranscriptEntities(agentId, 'todo');
        expect(state().todoNotesMeta?.rev).toBe(index === 3 ? 6 : 5);
        expect(state().todoRead).toEqual(index === 3 ? verified : undefined);
      }
      deliver(resetEvent(agentId, emptySnapshot(), 10));
      const partial = { ...ready, readiness: 'partial' as const, watermark: { transcript: { seq: 20, epoch: 'epoch-canonical' } } };
      entities.mockResolvedValueOnce({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [initial], has_more: true, next_cursor: 'next-todo', read: partial });
      await controller.loadTranscriptEntities(agentId, 'todo');
      entities.mockResolvedValueOnce({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [fresh], has_more: false,
        read: { ...ready, watermark: { transcript: { seq: 11, epoch: 'epoch-canonical' } } } });
      await controller.loadTranscriptEntities(agentId, 'todo');
      expect(state().todoNotesMeta?.rev).toBe(5);
      expect(state().todoRead).toEqual(partial);
    } finally { controller.close(); }
  });

  it.each(['main', 'child'] as const)('preserves the %s todo entity read source and readiness until its next baseline', async (agentId) => {
    const notes = { goal: 'Retained goal', next: 'Retained next action' };
    const notesMeta = { rev: 4, hash: 'notes-four', writtenTurn: 1, writtenStep: 't1.1', coveredMessageId: '', windowEpoch: 0 };
    const read = { source: 'derived' as const, readiness: 'partial' as const, reason: 'source_unverified' as const, watermark: { transcript: { seq: 9, epoch: 'source-epoch' } } };
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>(async () => ({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [{ todoId: 'todo', items: [], notes, notesMeta }], has_more: false, total: 1, read }));
    const { controller, deliver, view } = harness(undefined, undefined, entities);
    await controller.open();
    if (agentId === 'child') controller.retainAgentView('notes-child', agentId, 'delta');
    const state = () => agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
    try {
      deliver(resetEvent(agentId, emptySnapshot(), 2));
      expect(await controller.loadTranscriptEntities(agentId, 'todo')).toBe(true);
      expect(state().todoNotes).toEqual(notes);
      expect(state().todoNotesMeta).toEqual(notesMeta);
      expect(state().todoRead).toEqual(read);
      expect(state().historyRead).toBeUndefined();
      expect(state().globalCoverage?.todos?.hasMore).toBe(false);
      const other = agentId === 'main' ? controller.getAgentState('child') : controller.getState();
      expect(other.todoRead).toBeUndefined();
      const subscribe = vi.spyOn(view, 'subscribe');
      await controller.resync();
      expect(state().todoNotes).toEqual(notes);
      expect(state().todoRead).toEqual(read);
      if (agentId === 'child') expect(subscribe.mock.lastCall?.[0].transcriptGrades?.['child']).toBe('delta');
      deliver(resetEvent(agentId, emptySnapshot({ todos: [{ todoId: 'todo', items: [], notes, notesMeta: { ...notesMeta, rev: 5 } }] }), 3));
      expect(state().todoRead).toBeUndefined();
      expect(state().todoNotesMeta?.rev).toBe(5);
      entities.mockRejectedValueOnce(new Error('Read failed'));
      expect(await controller.loadTranscriptEntities(agentId, 'todo')).toBe(false);
      expect(state().todoNotes).toEqual(notes);
      expect(state().todoNotesMeta?.rev).toBe(5);
      expect(state().todoRead).toBeUndefined();
      entities.mockResolvedValueOnce({ session_id: 'session_test', agent_id: agentId, kind: 'todo', items: [], has_more: false });
      await controller.loadTranscriptEntities(agentId, 'todo');
      expect(state().todoRead).toBeUndefined();
      expect(state().todoNotes).toEqual(notes);
    } finally { controller.close(); }
  });

  it('continues root shell fields without losing transcript references', async () => {
    const root: import('@kiki/transcript').ContentRef = { source: { kind: 'snapshot', id: '' }, revision: 'fixture-root', path: ['session', 'title'], kind: 'text', offset: 3, total: 6 };
    const content = vi.fn(async () => ({ ref: root, value: 'def', contentRefs: [] }));
    const { controller, view, deliver } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue({ as_of_seq: 1, epoch: 'e', session: { ...session, title: 'abc' }, in_flight_turn: null, contentRefs: [root] } as SessionSnapshotResponse);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().contentRefs).toEqual([root]);
    await expect(controller.loadContentSegment('main', root)).resolves.toBe(true);
    expect(content.mock.contexts[0]).toBe(view.transcript);
    expect(controller.getState().session?.title).toBe('abcdef');
    expect(controller.getState().contentRefs).toEqual([]);
    controller.close();
  });

  it('loads global entities one explicit page at a time while a live entity wins over stale page data', async () => {
    const pageTask = (taskId: string, outputTail: string) => ({ taskId, outputTail, kind: 'shell' as const, state: 'completed' as const, detached: false, startedAt: FIXED_AT });
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>()
      .mockResolvedValueOnce({ session_id: 'session_test', agent_id: 'main', kind: 'task', items: [pageTask('task-shell', 'stale page output'), pageTask('task-b', 'page b')], has_more: true, next_cursor: 'next-page', total: 3 })
      .mockResolvedValueOnce({ session_id: 'session_test', agent_id: 'main', kind: 'task', items: [pageTask('task-c', 'page c')], has_more: false, total: 3 });
    const { controller, deliver, view } = harness(undefined, undefined, entities);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: [shellTask('live output', false)], items: windowed().items }), 2));
    expect(entities).not.toHaveBeenCalled();
    await expect(controller.loadTranscriptEntities('main', 'task')).resolves.toBe(true);
    expect(entities).toHaveBeenCalledTimes(1);
    expect(entities.mock.contexts[0]).toBe(view.transcript);
    expect(shellOf(controller)?.output).toBe('live output');
    expect(controller.getState().globalCoverage?.tasks).toEqual({ returned: 2, total: 3, hasMore: true });
    await expect(controller.loadTranscriptEntities('main', 'task')).resolves.toBe(true);
    expect(entities).toHaveBeenLastCalledWith({ agentId: 'main', kind: 'task', cursor: 'next-page', limit: 20 }, { signal: expect.any(AbortSignal) });
    expect(controller.getState().globalCoverage?.tasks).toEqual({ returned: 3, total: 3, hasMore: false });
    await expect(controller.loadTranscriptEntities('main', 'task')).resolves.toBe(false);
    expect(entities).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('clears stale and cancelled segment loading without changing the visible body', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'task', id: 'task-shell' }, revision: 'fixture-version', path: ['outputTail'], kind: 'text', offset: 3, total: 6 };
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((_input, options) => new Promise<import('@kiki/transcript').ContentSegment>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    const key = `content:${JSON.stringify(ref)}`;
    await expect(controller.loadContentSegment('main', ref)).resolves.toBe(false);
    expect(controller.getState().detailLoads[key]).toBeUndefined();
    deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('abc', false), contentRefs: [ref] }], items: windowed().items }), 2));
    const pending = controller.loadContentSegment('main', ref);
    expect(controller.getState().detailLoads[key]).toEqual({ status: 'loading' });
    controller.cancelContentSegment('main', ref);
    await expect(pending).resolves.toBe(false);
    expect(controller.getState().detailLoads[key]).toBeUndefined();
    expect(shellOf(controller)?.output).toBe('abc');
    controller.close();
  });

  it('continues a marker-only history window using its item cursor', async () => {
    const { controller, deliver, view } = harness(undefined);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'marker', markerId: 'm1', marker: 'clear' }], hasMoreOlder: true, olderCursor: 'marker:m1' }), 2, true));
    vi.mocked(view.transcript.page).mockResolvedValue({ tasks: [], attachments: [], interactions: [], todos: [], prompts: [], meta: {}, session_id: 'session_test', agent_id: 'main', items: [{ kind: 'marker', markerId: 'm0', marker: 'clear' }], has_more: false, agents: [], pending_interactions: [], cursor: { seq: 2, epoch: 'e' }, coverage: { kind: 'full', hasMoreOlder: false } });
    await expect(controller.loadOlderMessages()).resolves.toBe(true);
    expect(view.transcript.page).toHaveBeenCalledWith({ agentId: 'main', beforeTurn: undefined, beforeItem: 'marker:m1', pageSize: 20 });
    expect(controller.getState().loadingOlder).toBe(false);
    controller.close();
  });

  it('routes a frame output segment to the same canonical tool card and locator identity', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'frame', id: 'read-frame', turnId: 't1', stepId: 's1' }, revision: 'fixture-version', path: ['output'], kind: 'text', offset: 3, total: 6 };
    const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [
      { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [
        { kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [
          { kind: 'tool', frameId: 'read-frame', toolCallId: 'read-call', name: 'Read', state: 'done', output: 'abc', contentRefs: [ref] },
        ] },
      ] },
    ] }), 2));
    expect(controller.getState().contentRefs).toEqual([ref]);
    expect(content).not.toHaveBeenCalled();
    await expect(controller.loadContentSegment('main', ref)).resolves.toBe(true);
    expect(content).toHaveBeenCalledWith({ agentId: 'main', ref }, { signal: expect.any(AbortSignal) });
    expect(controller.getState().blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', id: 'tool-read-call', toolCallId: 'read-call', frameId: 'read-frame', stepId: 's1', turnId: 't1', output: 'abcdef' }),
    ]));
    expect(controller.getState().contentRefs).toEqual([]);
    await expect(controller.loadContentSegment('main', ref)).resolves.toBe(false);
    expect(content).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('continues the actual shell task output without replacing it with the frame output', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'task', id: 'task-shell' }, revision: 'fixture-version', path: ['outputTail'], kind: 'text', offset: 3, total: 6 };
    const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [
      { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [
        { kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [
          { kind: 'tool', frameId: 'bash-frame', toolCallId: 'bash-call', name: 'Bash', state: 'done', taskId: 'task-shell', input: { command: 'echo fixture' }, output: 'frame output' },
        ] },
      ] },
    ], tasks: [{ ...shellTask('abc', false), contentRefs: [ref] }] }), 2));
    expect(shellOf(controller)).toMatchObject({ output: 'abc', outputTaskId: 'task-shell', frameId: 'bash-frame', stepId: 's1' });
    await expect(controller.loadContentSegment('main', ref)).resolves.toBe(true);
    expect(shellOf(controller)).toMatchObject({ id: 'shell-bash-call', commandId: 'bash-call', output: 'abcdef', outputTaskId: 'task-shell' });
    controller.close();
  });
  it('projects the truncated tail with a detail marker and the window coverage', async () => {
    const { controller, deliver } = harness(vi.fn());
    await controller.open();
    deliver(resetEvent('main', windowed(), 2, true));
    expect(shellOf(controller)).toMatchObject({ output: '…tail line', outputDetail: { agentId: 'main', taskId: 'task-shell' } });
    expect(controller.getState().globalCoverage?.tasks).toEqual({ returned: 64, total: 70, hasMore: true });
    controller.close();
  });

  it('tolerates a reset from a server without windowed globals', async () => {
    const { controller, deliver } = harness(undefined);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: [shellTask('whole output', false)],
      items: windowed().items }), 2));
    expect(shellOf(controller)).toMatchObject({ output: 'whole output', outputDetail: undefined });
    expect(controller.getState().globalCoverage).toBeUndefined();
    await expect(controller.loadTranscriptDetail('main', 'task', 'task-shell')).resolves.toBe(false);
    controller.close();
  });

  it('publishes loading, then the full body; a failure publishes an error that a retry clears', async () => {
    let settle: ((value: SessionViewTranscriptDetail) => void) | undefined;
    const detail = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(() => new Promise<SessionViewTranscriptDetail>((resolve) => { settle = resolve; }));
    const { controller, deliver, view } = harness(detail);
    await controller.open();
    deliver(resetEvent('main', windowed(), 2, true));
    const key = transcriptDetailKey('task', 'task-shell');

    await expect(controller.loadTranscriptDetail('main', 'task', 'task-shell')).resolves.toBe(false);
    expect(controller.getState().detailLoads[key]).toEqual({ status: 'error', message: 'network down' });
    expect(shellOf(controller)?.output).toBe('…tail line');

    const retry = controller.loadTranscriptDetail('main', 'task', 'task-shell');
    // A second click while in flight joins the same read.
    const joined = controller.loadTranscriptDetail('main', 'task', 'task-shell');
    expect(controller.getState().detailLoads[key]).toEqual({ status: 'loading' });
    settle!(taskDetail('line 1\nline 2\n…tail line'));
    await expect(retry).resolves.toBe(true);
    await expect(joined).resolves.toBe(true);
    expect(detail).toHaveBeenCalledTimes(2);
    expect(detail.mock.contexts).toEqual([view.transcript, view.transcript]);
    expect(detail).toHaveBeenLastCalledWith({ agentId: 'main', kind: 'task', id: 'task-shell' });
    expect(controller.getState().detailLoads[key]).toBeUndefined();
    expect(shellOf(controller)).toMatchObject({ output: 'line 1\nline 2\n…tail line', outputDetail: undefined });
    controller.close();
  });

  it('keeps a newer live upsert instead of an older detail read', async () => {
    let settle: ((value: SessionViewTranscriptDetail) => void) | undefined;
    const detail = vi.fn(() => new Promise<SessionViewTranscriptDetail>((resolve) => { settle = resolve; }));
    const { controller, deliver } = harness(detail);
    await controller.open();
    deliver(resetEvent('main', windowed(), 2, true));
    const pending = controller.loadTranscriptDetail('main', 'task', 'task-shell');
    deliver(opsEvent('main', [{ op: 'task.upsert', task: shellTask('live full output', false) }], 3));
    settle!(taskDetail('stale full output'));
    await expect(pending).resolves.toBe(false);
    expect(shellOf(controller)?.output).toBe('live full output');
    controller.close();
  });

  it('hydrates a queued prompt whose content the window omitted', async () => {
    const detail = vi.fn(async (): Promise<SessionViewTranscriptDetail> => ({
      session_id: 'session_test', agent_id: 'main', kind: 'prompt',
      prompt: { promptId: 'p-long', status: 'queued', createdAt: FIXED_AT, queuePosition: 0, content: [{ type: 'text', text: 'a very long queued prompt' }] },
    } as SessionViewTranscriptDetail));
    const { controller, deliver } = harness(detail);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({
      prompts: [{ promptId: 'p-long', status: 'queued', createdAt: FIXED_AT, queuePosition: 0, detailRef: { kind: 'prompt', promptId: 'p-long' } }],
    } as Partial<AgentTranscriptSnapshot>), 2));
    await vi.waitFor(() => { expect(detail).toHaveBeenCalledWith({ agentId: 'main', kind: 'prompt', id: 'p-long' }); });
    await vi.waitFor(() => {
      const user = controller.getState().blocks.find((block): block is UserBlock => block.kind === 'user');
      expect(user?.text).toContain('a very long queued prompt');
    });
    controller.close();
  });

  it('marks an attachment whose source was omitted so it can be read on open', async () => {
    const { controller, deliver } = harness(vi.fn());
    await controller.open();
    const turn = {
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user', payload: { promptId: 'p1', userMessageId: 'um1' } },
      prompt: 'see image', attachmentIds: ['att-1'], startedAt: FIXED_AT, steps: [],
    };
    deliver(resetEvent('main', emptySnapshot({
      items: [turn] as unknown as AgentTranscriptSnapshot['items'],
      attachments: [{ attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png', size: 900_000, detailRef: { kind: 'attachment', attachmentId: 'att-1' } }],
    }), 2));
    const user = controller.getState().blocks.find((block): block is UserBlock => block.kind === 'user');
    expect(user?.media).toEqual([expect.objectContaining({
      kind: 'image', name: 'shot.png', detail: { agentId: 'main', attachmentId: 'att-1' },
    })]);
    expect(user?.media?.[0]?.url).toBeUndefined();
    controller.close();
  });
});


describe('visible snapshot and attachment continuation', () => {
  it('patches real snapshot.subagents into the existing roster', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'snapshot', id: '' }, revision: 'subagents', path: ['subagents'], kind: 'array', offset: 4, total: 6 };
    const children = Array.from({ length: 6 }, (_, index) => ({ id: `child${index}`, agent_id: `child${index}`, session_id: session.id, kind: 'subagent', description: `child${index}`, status: 'completed', live: false, created_at: FIXED_AT }));
    const content = vi.fn(async () => ({ ref, value: children.slice(4), contentRefs: [] }));
    const { controller, view, deliver } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue({ as_of_seq: 1, epoch: 'e', session, in_flight_turn: null, subagents: children.slice(0, 4), contentRefs: [ref] } as unknown as SessionSnapshotResponse);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    await expect(controller.loadContentSegment('main', ref)).resolves.toBe(true);
    expect(controller.getState().snapshotSubagents).toHaveLength(6);
    expect(controller.getState().snapshotSubagents?.map((child) => child.agent_id)).toEqual(children.map((child) => child.agent_id));
    expect(controller.getState().contentRefs).toEqual([]);
    controller.close();
  });

  it('loads a missing attachment referenced by a visible turn through the existing by-ID action', async () => {
    const detail = vi.fn(async () => ({ session_id: session.id, agent_id: 'main', kind: 'attachment', attachment: { attachmentId: 'att0', mediaType: 'image/png', source: { kind: 'session_media', fileId: 'file0' } } }) as SessionViewTranscriptDetail);
    const { controller, deliver } = harness(detail);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'image', attachmentIds: ['att0'], steps: [] }] }), 2));
    const user = () => controller.getState().blocks.find((block): block is UserBlock => block.kind === 'user');
    expect(user()?.media).toEqual([{ kind: 'file', detail: { agentId: 'main', attachmentId: 'att0' } }]);
    await expect(controller.loadTranscriptDetail('main', 'attachment', 'att0')).resolves.toBe(true);
    expect(user()?.media).toEqual([expect.objectContaining({ kind: 'image', fileId: 'file0' })]);
    controller.close();
  });
});
