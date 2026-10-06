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
  return { controller, deliver, view };
}

const shellOf = (controller: SessionController) =>
  controller.getState().blocks.find((block): block is ShellBlock => block.kind === 'shell');

function taskDetail(outputTail: string): SessionViewTranscriptDetail {
  return { session_id: 'session_test', agent_id: 'main', kind: 'task', task: shellTask(outputTail, false) } as SessionViewTranscriptDetail;
}

describe('SessionController transcript detail', () => {
  it('loads the complete queued edit content instead of submitting its truncated media preview', async () => {
    const source = { kind: 'prompt' as const, id: 'queued-original' };
    const ref: import('@kiki/transcript').ContentRef = { source, revision: 'original', path: ['content', 1, 'source', 'data'], kind: 'text', offset: 4, total: 8 };
    const content = vi.fn(async () => ({ ref, value: 'BBBB', contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ prompts: [{ promptId: source.id, status: 'queued', createdAt: FIXED_AT,
      content: [{ type: 'text', text: 'full text' }, { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } }], contentRefs: [ref] }] }), 2));
    try {
      const original = await controller.readQueuedPromptContent(source.id);
      expect(original).toEqual([{ type: 'text', text: 'full text' }, { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAABBBB' } }]);
      expect(content).toHaveBeenCalledTimes(1);
      expect(controller.contentRefsFor('main', source)).toEqual([]);
    } finally { controller.close(); }
  });
  it.each(['main', 'child'] as const)('reads only the requested %s turn structure and leaves other cold turns unread', async (agentId) => {
    const turns = [3, 1].map((total, ordinal) => {
      const source = { kind: 'turn' as const, id: `turn-${ordinal}` };
      const ref: import('@kiki/transcript').ContentRef = { source, revision: 'latest-first', path: ['steps'], kind: 'array', offset: 0, total };
      const steps = Array.from({ length: total }, (_, step) => ({ stepId: `${source.id}-step-${step}`, ordinal: step, state: 'completed' as const,
        frames: [{ kind: 'tool' as const, frameId: `${source.id}-frame-${step}`, toolCallId: `${source.id}-call-${step}`, toolName: 'Example', state: 'completed' as const, output: 'preview' }] }));
      return { source, ref, steps, preview: { kind: 'turn' as const, turnId: source.id, ordinal, state: 'completed' as const,
        origin: { kind: 'user' as const }, prompt: `Message ${ordinal}`, steps: [], contentRefs: [ref] } };
    });
    const content = vi.fn(async ({ ref }: { ref: import('@kiki/transcript').ContentRef }) => {
      const turn = turns.find((turn) => turn.source.id === ref.source.id)!;
      return { ref, value: turn.steps.slice(ref.offset, ref.offset + 1), contentRefs: [],
        next: ref.offset + 1 < ref.total ? { ...ref, offset: ref.offset + 1 } : undefined };
    });
    const { controller, deliver, view } = harness(undefined, content);
    await controller.open();
    if (agentId !== 'main') controller.retainAgentView('child-view', agentId, 'delta');
    deliver(resetEvent(agentId, emptySnapshot({ items: turns.map((turn) => turn.preview) }), 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(content).not.toHaveBeenCalled();
    const release = controller.retainHistoryStructure(agentId, turns[1]!.source.id);
    try {
      await vi.waitFor(() => {
        const state = agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
        expect(state.blocks.filter((block) => block.kind === 'tool')).toHaveLength(1);
        expect(state.contentRefs?.some((ref) => ref.source.id === 'turn-1' && ref.path[0] === 'steps')).toBe(false);
      });
      expect(content.mock.calls.map(([input]) => input.ref.source.id)).toEqual(['turn-1']);
      expect((agentId === 'main' ? controller.getState() : controller.getAgentState(agentId)).contentRefs).toContainEqual(turns[0]!.ref);
      expect(view.transcript.page).not.toHaveBeenCalled();
    } finally { release(); controller.close(); }
  });
  it('continues a retained turn structure when its references arrive after the reader', async () => {
    const source = { kind: 'turn' as const, id: 'late-structure' };
    const ref: import('@kiki/transcript').ContentRef = { source, revision: 'late', path: ['steps'], kind: 'array', offset: 0, total: 1 };
    const turn = { kind: 'turn' as const, turnId: source.id, ordinal: 0, state: 'completed' as const,
      origin: { kind: 'user' as const }, prompt: 'Visible turn', steps: [] };
    const content = vi.fn(async () => ({ ref, value: [{ stepId: 'step', ordinal: 0, state: 'completed' as const,
      frames: [{ kind: 'tool' as const, frameId: 'frame', toolCallId: 'call', toolName: 'Example', state: 'completed' as const, output: 'loaded' }] }], contentRefs: [] }));
    const { controller, deliver, view } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [turn] }), 2));
    const release = controller.retainHistoryStructure('main', source.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(content).not.toHaveBeenCalled();
      deliver(opsEvent('main', [{ op: 'turn.upsert', turn: { ...turn, contentRefs: [ref] } }], 3));
      await vi.waitFor(() => expect(controller.getState().blocks.filter((block) => block.kind === 'tool')).toHaveLength(1));
      expect(content).toHaveBeenCalledTimes(1);
      expect(view.transcript.page).not.toHaveBeenCalled();
    } finally { release(); controller.close(); }
  });
  it.each(['main', 'child'] as const)('automatically restores 0/6 step structures and new nested frame refs for opened %s history through preparation and transient failure', async (agentId) => {
    const { RPCError } = await import('@kiki/klient/session-view');
    const source = { kind: 'turn' as const, id: 'structure-turn' };
    const canonical = { kind: 'turn' as const, turnId: source.id, ordinal: 0, state: 'completed' as const,
      origin: { kind: 'user' as const }, prompt: 'old historical structure', steps: Array.from({ length: 6 }, (_, step) => ({
        stepId: `step-${step}`, ordinal: step, state: 'completed' as const,
        frames: Array.from({ length: 7 }, (_, frame) => ({ kind: 'tool' as const, frameId: `frame-${step}-${frame}`,
          toolCallId: `call-${step}-${frame}`, toolName: 'Example', state: 'completed' as const, output: 'preview' })),
      })) };
    const structural: import('@kiki/transcript').ContentRef = { source, revision: 'fixture-structure', path: ['steps'], kind: 'array', offset: 0, total: 6 };
    const preview = { ...canonical, steps: [], contentRefs: [structural] };
    const content = vi.fn().mockRejectedValueOnce(new RPCError(40923, 'preparing'))
      .mockRejectedValueOnce(new RPCError(-1, 'temporary disconnect'))
      .mockImplementation(async ({ ref }: { ref: import('@kiki/transcript').ContentRef }) => {
        if (ref.path.length === 1) {
          const steps = canonical.steps.slice(ref.offset, ref.offset + 3);
          return { ref, value: steps.map((step) => ({ ...step, frames: [] })),
            contentRefs: steps.map((step) => ({ ...structural, path: ['steps', step.ordinal, 'frames'], total: 7 })),
            next: ref.offset + 3 < 6 ? { ...ref, offset: ref.offset + 3 } : undefined };
        }
        return { ref, value: canonical.steps[Number(ref.path[1])]!.frames, contentRefs: [] };
      });
    const { controller, deliver, view } = harness(undefined, content);
    await controller.open();
    if (agentId !== 'main') controller.retainAgentView('child-view', agentId, 'delta');
    deliver(resetEvent(agentId, emptySnapshot({ items: [preview] }), 2));
    const release = controller.retainHistoryStructure(agentId, source.id);
    try {
      await vi.waitFor(() => {
        const state = agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
        expect(state.blocks.filter((block) => block.kind === 'tool')).toHaveLength(42);
        expect(state.contentRefs?.some((ref) => ref.path[0] === 'steps')).toBe(false);
        expect(Object.values(state.detailLoads).some((load) => load.status === 'error')).toBe(false);
      }, { timeout: 5000 });
      expect(content.mock.calls.length).toBeGreaterThan(2);
      expect(view.transcript.page).not.toHaveBeenCalled();
    } finally { release(); controller.close(); }
  });
  it('reports a stalled step segment once instead of automatically looping on an unchanged reference', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'turn', id: 'stalled' }, revision: 'r', path: ['steps'], kind: 'array', offset: 0, total: 6 };
    const content = vi.fn(async () => ({ ref, value: [], next: ref, contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 'stalled', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'retained prompt', steps: [], contentRefs: [ref] }] }), 2));
    const release = controller.retainHistoryStructure('main', 'stalled');
    try {
      await vi.waitFor(() => expect(Object.values(controller.getState().detailLoads)).toContainEqual({ status: 'error', message: 'Content segment did not advance its reference' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(content).toHaveBeenCalledTimes(1);
      expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({ text: 'retained prompt' });
      expect(controller.getState().contentRefs).toContainEqual(ref);
    } finally { release(); controller.close(); }
  });

  it('retains inventory counts beyond the roster window and refreshes a cold child completion without reading its body', async () => {
    const { controller, view, deliver } = harness(undefined);
    const counts = { total: 301, subagents: 300, completed: 299, failed: 0, cancelled: 0, active: 1, unknown: 0 };
    const shell: SessionSnapshotResponse = { as_of_seq: 1, epoch: 'e', session, in_flight_turn: null,
      messages: { items: [], has_more: false }, pending_approvals: [], pending_questions: [], subagents: [], agent_counts: counts };
    vi.mocked(view.snapshot).mockResolvedValue(shell);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().agentCounts).toEqual(counts);
    expect(controller.getState().snapshotSubagents).toEqual([]);
    expect(view.transcript.page).not.toHaveBeenCalled();
    vi.mocked(view.snapshot).mockResolvedValue({ ...shell, as_of_seq: 2, agent_counts: { ...counts, completed: 300, active: 0 },
      subagents: [{ id: 'old-child', agent_id: 'old-child', session_id: 'session_test', kind: 'subagent',
        description: 'Old child', status: 'completed', live: false, created_at: FIXED_AT }] });
    deliver(opsEvent('main', [{ op: 'task.upsert', task: { taskId: 'old-child-task', agentId: 'old-child', kind: 'subagent', state: 'completed', detached: false, startedAt: FIXED_AT, outputTail: '' } }], 3));
    await vi.waitFor(() => expect(controller.getState().agentCounts?.completed).toBe(300));
    expect(controller.getState().agentCounts?.total).toBe(301);
    expect(view.transcript.page).not.toHaveBeenCalled();
    expect(controller.getAgentState('old-child').loaded).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    const reads = vi.mocked(view.snapshot).mock.calls.length;
    deliver(opsEvent('main', [{ op: 'task.upsert', task: { taskId: 'old-child-task', agentId: 'old-child', kind: 'subagent', state: 'completed', detached: false, startedAt: FIXED_AT, outputTail: 'updated preview' } }], 4));
    await Promise.resolve();
    expect(view.snapshot).toHaveBeenCalledTimes(reads);
    controller.close();
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
    expect(view.transcript.page).toHaveBeenCalledWith({ agentId: 'main', beforeTurn: undefined, beforeItem: 'marker:m1', pageSize: 20 }, { signal: expect.any(AbortSignal) });
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
  it('automatically patches real snapshot.subagents into the existing roster without opening a child', async () => {
    const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'snapshot', id: '' }, revision: 'subagents', path: ['subagents'], kind: 'array', offset: 4, total: 6 };
    const children = Array.from({ length: 6 }, (_, index) => ({ id: `child${index}`, agent_id: `child${index}`, session_id: session.id, kind: 'subagent', description: `child${index}`, status: 'completed', live: false, created_at: FIXED_AT }));
    const content = vi.fn(async () => ({ ref, value: children.slice(4), contentRefs: [] }));
    const { controller, view, deliver } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue({ as_of_seq: 1, epoch: 'e', session, in_flight_turn: null, subagents: children.slice(0, 4), contentRefs: [ref] } as unknown as SessionSnapshotResponse);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents).toHaveLength(6));
    expect(content).toHaveBeenCalledTimes(1);
    expect(view.transcript.page).not.toHaveBeenCalled();
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

describe('automatic target reading', () => {
  it('bounds independent field reads and admits the next field when a slot finishes', async () => {
    const sources = Array.from({ length: 5 }, (_, index) => ({ kind: 'task' as const, id: `bounded-${index}` }));
    const refs = sources.map((source) => ({ source, revision: 'bounded', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 6 }));
    const held = new Map<string, () => void>();
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((input) => new Promise((resolve) => {
      held.set(input.ref.source.id, () => { resolve({ ref: input.ref, value: 'def', contentRefs: [] }); });
    }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: sources.map((source, index) => ({ ...shellTask('abc', false), taskId: source.id, contentRefs: [refs[index]!] })), items: windowed().items }), 2));
    const leases = sources.map((source) => controller.beginContentRead('main', source, ['outputTail']));
    try {
      await vi.waitFor(() => expect(content).toHaveBeenCalledTimes(4));
      expect(held.has('bounded-4')).toBe(false);
      held.get('bounded-0')!();
      await vi.waitFor(() => expect(content).toHaveBeenCalledTimes(5));
      expect(held.has('bounded-4')).toBe(true);
    } finally {
      for (const lease of leases) lease.release();
      for (const settle of held.values()) settle();
      controller.close();
    }
  });

  it('keeps another expanded field progressing while an unrelated field waits for its response', async () => {
    const sources = ['task-shell', 'task-second'].map((id) => ({ kind: 'task' as const, id }));
    const refs = sources.map((source) => ({ source, revision: 'independent', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 6 }));
    let settle!: (segment: import('@kiki/transcript').ContentSegment) => void;
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((input) => input.ref.source.id === 'task-shell'
      ? new Promise((resolve) => { settle = resolve; })
      : Promise.resolve({ ref: refs[1]!, value: 'def', contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: sources.map((source, index) => ({ ...shellTask('abc', false), taskId: source.id, contentRefs: [refs[index]!] })), items: windowed().items }), 2));
    const first = controller.beginContentRead('main', sources[0]!, ['outputTail']);
    const second = controller.beginContentRead('main', sources[1]!, ['outputTail']);
    try {
      await vi.waitFor(() => expect(content.mock.calls.some(([input]) => input.ref.source.id === 'task-second')).toBe(true));
      expect(controller.getState().contentRefs).toContainEqual(refs[0]);
      expect(controller.getState().contentRefs).not.toContainEqual(refs[1]);
      expect(content.mock.calls.filter(([input]) => input.ref.source.id === 'task-shell')).toHaveLength(1);
    } finally {
      first.release(); second.release(); settle?.({ ref: refs[0]!, value: 'def', contentRefs: [] }); controller.close();
    }
  });

  it('paints the preview first then automatically follows newly discovered child refs; failure resumes with one retry and reopens from cache', async () => {
    const source = { kind: 'task' as const, id: 'task-shell' };
    const root = { source, revision: 'r1', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 9 };
    const next = { ...root, offset: 6 };
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>()
      .mockRejectedValueOnce(new Error('offline once'))
      .mockResolvedValueOnce({ ref: root, value: 'def', next, contentRefs: [] })
      .mockResolvedValueOnce({ ref: next, value: 'ghi', contentRefs: [] });
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('abc', false), contentRefs: [root] }], items: windowed().items }), 2));
    const lease = controller.beginContentRead('main', source, ['outputTail']);
    expect(shellOf(controller)?.output).toBe('abc');
    expect(content).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(controller.getState().detailLoads[`content:${JSON.stringify(root)}`]?.status).toBe('error'));
    expect(content).toHaveBeenCalledTimes(1);
    lease.retry();
    await vi.waitFor(() => expect(shellOf(controller)?.output).toBe('abcdefghi'));
    expect(controller.getState().contentRefs).toEqual([]);
    lease.release();
    const reopened = controller.beginContentRead('main', source, ['outputTail']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(content).toHaveBeenCalledTimes(3);
    reopened.release(); controller.close();
  });

  it('cancels only the last reader and a late cancelled response cannot patch a new scope', async () => {
    const source = { kind: 'task' as const, id: 'task-shell' };
    const ref = { source, revision: 'r1', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 6 };
    let settle!: (segment: import('@kiki/transcript').ContentSegment) => void;
    let signal: AbortSignal | undefined;
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((_input, options) => { signal = options?.signal; return new Promise((resolve) => { settle = resolve; }); });
    const { controller, deliver } = harness(undefined, content);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('abc', false), contentRefs: [ref] }], items: windowed().items }), 2));
    const one = controller.beginContentRead('main', source, ['outputTail']);
    const two = controller.beginContentRead('main', source, ['outputTail']);
    await vi.waitFor(() => expect(content).toHaveBeenCalledTimes(1));
    one.release(); expect(signal?.aborted).toBe(false);
    two.release(); expect(signal?.aborted).toBe(true);
    deliver(resetEvent('main', emptySnapshot({ tasks: [shellTask('new target', false)], items: windowed().items }), 3));
    settle({ ref, value: 'def', contentRefs: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shellOf(controller)?.output).toBe('new target');
    controller.close();
  });

  it('looks up a known call in its real caller without requesting an older history page and copies full selected output', async () => {
    const frame = { kind: 'tool' as const, frameId: 'hidden-frame', toolCallId: 'known-call', name: 'AgentRun', state: 'done' as const, output: 'abc' };
    const ref = { source: { kind: 'frame' as const, id: frame.frameId, turnId: 'hidden-turn', stepId: 'hidden-step' }, revision: 'r', path: ['output'], kind: 'text' as const, offset: 3, total: 6 };
    const detail = vi.fn(async () => ({ session_id: 'session_test', agent_id: 'caller-child', kind: 'tool', lookup: { status: 'found', turnId: 'hidden-turn', stepId: 'hidden-step', frame: { ...frame, contentRefs: [ref] } } }) as SessionViewTranscriptDetail);
    const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
    const { controller, view, deliver } = harness(detail, content);
    await controller.open(); deliver(resetEvent('main', emptySnapshot(), 2));
    await expect(controller.copyToolCallField('caller-child', 'known-call', 'output')).resolves.toBe('abcdef');
    expect(detail).toHaveBeenCalledWith({ agentId: 'caller-child', kind: 'tool', id: 'known-call' }, { signal: expect.any(AbortSignal) });
    expect(view.transcript.page).not.toHaveBeenCalled();
    expect(content).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('does not append an oversized text; random visible ranges use a bounded reusable cache', async () => {
    const source = { kind: 'task' as const, id: 'task-shell' };
    const ref = { source, revision: 'big', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 2_000_000 };
    const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => ({ ref, value: 'x'.repeat(32_766), next: { ...ref, offset: ref.offset + 32_766 }, contentRefs: [] }));
    const { controller, deliver } = harness(undefined, content);
    await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('abc', false), contentRefs: [ref] }], items: windowed().items }), 2));
    const lease = controller.beginContentRead('main', source, ['outputTail']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(content).not.toHaveBeenCalled(); expect(shellOf(controller)?.output).toBe('abc');
    expect(await controller.readContentRange('main', ref, 100_000)).toHaveLength(4096);
    await controller.readContentRange('main', ref, 100_000);
    expect(content).toHaveBeenCalledTimes(1);
    expect(controller.contentMemoryReport().rangeBytes).toBe(8192);
    lease.release(); controller.close();
  });
});

it('a same-revision bounded live upsert cannot replace a hydrated output with its prefix, but a new revision can', async () => {
  const frame = { kind: 'tool' as const, frameId: 'frame', toolCallId: 'call', name: 'Read', state: 'done' as const, output: 'abc' };
  const ref = { source: { kind: 'frame' as const, id: 'frame', turnId: 't1', stepId: 's1' }, revision: 'r1', path: ['output'], kind: 'text' as const, offset: 3, total: 6 };
  const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
  const { controller, deliver } = harness(undefined, content);
  await controller.open();
  deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ ...frame, contentRefs: [ref] }] }] }] }), 2));
  await controller.loadContentSegment('main', ref);
  deliver(opsEvent('main', [{ op: 'frame.upsert', turnId: 't1', stepId: 's1', frame: { ...frame, contentRefs: [ref] } }], 3));
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'tool', output: 'abcdef' }));
  deliver(opsEvent('main', [{ op: 'frame.upsert', turnId: 't1', stepId: 's1', frame: { ...frame, output: 'new', contentRefs: [{ ...ref, revision: 'r2' }] } }], 4));
  controller.flushFrames();
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'tool', output: 'new' }));
  controller.close();
});

it('evicts closed hydrated bodies within the byte budget and restores only the matching revision preview', async () => {
  const size = 400_000;
  const tasks = Array.from({ length: 24 }, (_, index) => {
    const taskId = `body-${index}`;
    const ref = { source: { kind: 'task' as const, id: taskId }, revision: `r${index}`, path: ['outputTail'], kind: 'text' as const, offset: 3, total: size };
    return { ...shellTask('abc', false), taskId, contentRefs: [ref] };
  });
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => {
    const end = Math.min(ref.total, ref.offset + 32_000);
    return { ref, value: 'x'.repeat(end - ref.offset), next: end < ref.total ? { ...ref, offset: end } : undefined, contentRefs: [] };
  });
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks }), 2));
  for (const task of tasks) await controller.completeContentRead('main', { kind: 'task', id: task.taskId }, ['outputTail']);
  expect(controller.contentMemoryReport().bodyBytes).toBeLessThanOrEqual(controller.contentMemoryReport().bodyBudget);
  expect(controller.contentRefsFor('main', { kind: 'task', id: 'body-0' })).toEqual(tasks[0]!.contentRefs);
  const before = content.mock.calls.length;
  await controller.completeContentRead('main', { kind: 'task', id: 'body-23' }, ['outputTail']);
  expect(content).toHaveBeenCalledTimes(before);
  controller.close();
});

it('an old cache preview never rolls back a new revision when it is evicted', async () => {
  const { applyContentSegment, mergeContentPreview, restoreContentPreview } = await import('@kiki/transcript');
  const ref = { source: { kind: 'task' as const, id: 'body' }, revision: 'old', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 6 };
  const base = { outputTail: 'abc', contentRefs: [ref] };
  const full = applyContentSegment(base, { ref, value: 'def', contentRefs: [] });
  const updated = mergeContentPreview(full, { outputTail: 'new', contentRefs: [{ ...ref, revision: 'new' }] });
  expect(restoreContentPreview(updated, base).outputTail).toBe('new');
  expect(restoreContentPreview(full, base)).toEqual(base);
});


it('reuses a live canonical call and keeps retained bodies accounted after a same-revision reset', async () => {
  const frame = { kind: 'tool' as const, frameId: 'frame', toolCallId: 'call', name: 'Read', state: 'done' as const, output: 'abc' };
  const ref = { source: { kind: 'frame' as const, id: 'frame', turnId: 't1', stepId: 's1' }, revision: 'r1', path: ['output'], kind: 'text' as const, offset: 3, total: 6 };
  const snapshot = emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ ...frame, contentRefs: [ref] }] }] }] });
  const detail = vi.fn<NonNullable<SessionViewFacade['transcript']['detail']>>();
  const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
  const { controller, deliver } = harness(detail, content);
  await controller.open(); deliver(resetEvent('main', snapshot, 2));
  await controller.completeContentRead('main', ref.source, ['output']);
  await expect(controller.copyToolCallField('main', 'call', 'output')).resolves.toBe('abcdef');
  const bytes = controller.contentMemoryReport().bodyBytes;
  expect(bytes).toBeGreaterThan(0);
  deliver(resetEvent('main', snapshot, 3));
  expect(controller.contentMemoryReport().bodyBytes).toBe(bytes);
  await expect(controller.copyToolCallField('main', 'call', 'output')).resolves.toBe('abcdef');
  expect(detail).not.toHaveBeenCalled(); expect(content).toHaveBeenCalledTimes(1);
  deliver(resetEvent('main', emptySnapshot(), 4));
  expect(controller.contentMemoryReport().bodyBytes).toBe(0);
  controller.close();
});

it('cancels one point-lookup reader without aborting another and aborts the last reader', async () => {
  let networkSignal: AbortSignal | undefined;
  const detail = vi.fn<NonNullable<SessionViewFacade['transcript']['detail']>>((_query, options) => new Promise((_resolve, reject) => {
    networkSignal = options?.signal;
    networkSignal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }));
  const { controller } = harness(detail);
  await controller.open();
  const first = new AbortController(), second = new AbortController();
  const a = controller.lookupToolCall('caller-child', 'known', first.signal);
  const b = controller.lookupToolCall('caller-child', 'known', second.signal);
  first.abort(); await expect(a).rejects.toMatchObject({ name: 'AbortError' });
  expect(networkSignal?.aborted).toBe(false); expect(detail).toHaveBeenCalledTimes(1);
  second.abort(); await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  expect(networkSignal?.aborted).toBe(true);
  controller.close();
});


it('automatically hydrates an object child while its parent still has unread entries', async () => {
  const source = { kind: 'frame' as const, id: 'frame', turnId: 't1', stepId: 's1' };
  const root = { source, revision: 'object', path: ['input'], kind: 'object' as const, offset: 0, total: 2 };
  const child = { source, revision: 'child', path: ['input', 'first'], kind: 'text' as const, offset: 3, total: 6 };
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => ref.kind === 'text' ? { ref, value: 'def', contentRefs: [] } : ref.offset === 0 ? { ref, value: { first: 'abc' }, contentRefs: [child], next: { ...root, offset: 1 } } : { ref, value: { second: 'complete' }, contentRefs: [] });
  const { controller, deliver } = harness(undefined, content);
  await controller.open();
  deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'frame', toolCallId: 'call', name: 'Read', state: 'done', input: {}, contentRefs: [root] }] }] }] }), 2));
  const lease = controller.beginContentRead('main', source, ['input']);
  await vi.waitFor(() => expect(controller.contentRefsFor('main', source)).toEqual([]));
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'tool', args: { first: 'abcdef', second: 'complete' } }));
  expect(content).toHaveBeenCalledTimes(3);
  lease.release(); controller.close();
});

it('retains a hydrated prompt across unrelated frame changes, bounded turn upserts and resets', async () => {
  const source = { kind: 'turn' as const, id: 't1' };
  const ref = { source, revision: 'r1', path: ['prompt'], kind: 'text' as const, offset: 3, total: 6 };
  const frame = { kind: 'tool' as const, frameId: 'f1', toolCallId: 'call', name: 'Read', state: 'done' as const, output: 'first' };
  const turn = { kind: 'turn' as const, turnId: 't1', ordinal: 1, state: 'completed' as const, origin: { kind: 'user' as const }, prompt: 'abc', contentRefs: [ref], steps: [{ kind: 'step' as const, stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed' as const, frames: [frame] }] };
  const content = vi.fn(async () => ({ ref, value: 'def', contentRefs: [] }));
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ items: [turn] }), 2));
  await controller.completeContentRead('main', source, ['prompt']);
  deliver(opsEvent('main', [{ op: 'frame.upsert', turnId: 't1', stepId: 's1', frame: { ...frame, output: 'second' } }], 3));
  controller.flushFrames();
  const { steps: _steps, ...header } = turn;
  deliver(opsEvent('main', [{ op: 'turn.upsert', turn: header }], 4)); controller.flushFrames();
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'user', text: 'abcdef' }));
  deliver(resetEvent('main', emptySnapshot({ items: [turn] }), 5));
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'user', text: 'abcdef' }));
  expect(controller.contentRefsFor('main', source)).toEqual([]);
  deliver(opsEvent('main', [{ op: 'turn.upsert', turn: { ...header, prompt: 'new', contentRefs: [{ ...ref, revision: 'r2' }] } }], 6)); controller.flushFrames();
  expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'user', text: 'new' }));
  controller.close();
});

it('copies oversized text exactly across a surrogate pair on a range boundary', async () => {
  const text = 'a'.repeat(4095) + '😀' + 'b'.repeat(600_000 - 4097);
  const source = { kind: 'task' as const, id: 'task-shell' };
  const ref = { source, revision: 'unicode', path: ['outputTail'], kind: 'text' as const, offset: 3, total: text.length };
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => {
    let start = ref.offset;
    if (start > 0 && /[\uD800-\uDBFF]/u.test(text[start - 1]!)) start -= 1;
    let end = Math.min(text.length, start + 4097);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    return { ref: { ...ref, offset: start }, value: text.slice(start, end), contentRefs: [] };
  });
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('aaa', false), contentRefs: [ref] }] }), 2));
  await expect(controller.copyContentField('main', source, ['outputTail'])).resolves.toBe(text);
  expect(controller.contentMemoryReport().rangeBytes).toBeLessThanOrEqual(controller.contentMemoryReport().rangeBudget);
  controller.close();
});

it('aborts an unowned range HTTP request on scope reset without caching the late value', async () => {
  const ref = { source: { kind: 'task' as const, id: 'task-shell' }, revision: 'old', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 600_000 };
  let signal: AbortSignal | undefined;
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((_input, options) => new Promise((_resolve, reject) => {
    signal = options?.signal; signal?.addEventListener('abort', () => { reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
  }));
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot(), 2));
  const pending = controller.readContentRange('main', ref, 0);
  deliver(resetEvent('main', emptySnapshot(), 3));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(signal?.aborted).toBe(true); expect(controller.contentMemoryReport().rangeBytes).toBe(0);
  controller.close();
});

it('copies the error field actually displayed when a tool has no output field', async () => {
  const { controller, deliver } = harness(undefined);
  await controller.open();
  deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'f', toolCallId: 'call', name: 'Read', state: 'error', error: 'engine failure' }] }] }] }), 2));
  await expect(controller.copyToolCallField('main', 'call', 'output')).resolves.toBe('engine failure');
  controller.close();
});

it('evicts a newly hydrated revision to its new preview rather than leaving an unaccounted body', async () => {
  const tasks = Array.from({ length: 24 }, (_, index) => ({ ...shellTask('abc', false), taskId: `body-${index}`, contentRefs: [{ source: { kind: 'task' as const, id: `body-${index}` }, revision: `r${index}`, path: ['outputTail'], kind: 'text' as const, offset: 3, total: 400_000 }] }));
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => {
    const end = Math.min(ref.total, ref.offset + 32_000);
    return { ref, value: 'x'.repeat(end - ref.offset), next: end < ref.total ? { ...ref, offset: end } : undefined, contentRefs: [] };
  });
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks }), 2));
  await controller.completeContentRead('main', { kind: 'task', id: 'body-0' }, ['outputTail']);
  const next = { ...tasks[0]!, outputTail: 'new', contentRefs: [{ ...tasks[0]!.contentRefs[0]!, revision: 'updated', total: 100_000 }] };
  deliver(opsEvent('main', [{ op: 'task.upsert', task: next }], 3)); controller.flushFrames();
  await controller.completeContentRead('main', { kind: 'task', id: 'body-0' }, ['outputTail']);
  for (const task of tasks.slice(1)) await controller.completeContentRead('main', { kind: 'task', id: task.taskId }, ['outputTail']);
  expect(controller.contentRefsFor('main', { kind: 'task', id: 'body-0' })).toEqual(next.contentRefs);
  controller.close();
});


it('copies legal large text in temporary reads without widening the resident budget', async () => {
  const text = 'large 😀 body '.repeat(400_000) + 'FULL-COPY-TAIL';
  const source = { kind: 'task' as const, id: 'task-shell' };
  const ref = { source, revision: 'large', path: ['outputTail'], kind: 'text' as const, offset: 3, total: text.length };
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => {
    let end = Math.min(ref.total, ref.offset + 32_000);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    return { ref, value: text.slice(ref.offset, end), contentRefs: [], next: end < ref.total ? { ...ref, offset: end } : undefined };
  });
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask(text.slice(0, 3), false), contentRefs: [ref] }] }), 2));
  const before = controller.contentMemoryReport();
  expect(text.length * 2).toBeGreaterThan(before.bodyBudget);
  await expect(controller.copyContentField('main', source, ['outputTail'])).resolves.toBe(text);
  expect(controller.contentMemoryReport()).toEqual(before);
  expect(controller.contentRefsFor('main', source)).toEqual([ref]);
  controller.close();
});

it('cancels explicit temporary copy and never returns a prefix or retains the late read', async () => {
  const source = { kind: 'task' as const, id: 'task-shell' };
  const ref = { source, revision: 'copy-cancel', path: ['outputTail'], kind: 'text' as const, offset: 3, total: 6_000_000 };
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>((_input, options) => new Promise((resolve) => {
    signal = options?.signal;
    finish = () => resolve({ ref, value: 'late', contentRefs: [] });
  }));
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ tasks: [{ ...shellTask('abc', false), contentRefs: [ref] }] }), 2));
  const abort = new AbortController();
  const pending = controller.copyContentField('main', source, ['outputTail'], abort.signal);
  abort.abort(); finish();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(signal?.aborted).toBe(true);
  expect(controller.contentMemoryReport().bodyBytes).toBe(0);
  expect(controller.contentRefsFor('main', source)).toEqual([ref]);
  controller.close();
});

it.each([false, true])('finds an unread large range match across a chunk boundary without hydrating its turn (Unicode: %s)', async (unicode) => {
  const prefix = unicode ? 'a'.repeat(4095) + '😀 ' : 'a'.repeat(4090) + ' ';
  const text = prefix + 'RANGE-BOUNDARY-NEEDLE ' + 'b'.repeat(600_000);
  const source = { kind: 'frame' as const, id: 'f-range', turnId: 't1', stepId: 's1' };
  const ref = { source, revision: 'range-find', path: ['output'], kind: 'text' as const, offset: 3, total: text.length };
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => ({ ref, value: text.slice(ref.offset, ref.offset + 4097), contentRefs: [] }));
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: 'f-range', toolCallId: 'call-range', name: 'Read', state: 'done', output: 'aaa', contentRefs: [ref] }] }] }] }), 2));
  await expect(controller.findTurnContentRange('main', 1, /RANGE-BOUNDARY-NEEDLE/gu)).resolves.toEqual({ ref, offset: prefix.length, toolCallId: 'call-range' });
  expect(content).toHaveBeenCalledTimes(2);
  expect(controller.contentRefsFor('main', source)).toEqual([ref]);
  expect(controller.contentMemoryReport().bodyBytes).toBeLessThan(8 * 1024 * 1024);
  controller.close();
});


it('copies a large structured invocation input including newly discovered prompt refs without retaining it', async () => {
  const prompt = 'prompt '.repeat(700_000);
  const source = { kind: 'frame' as const, id: 'input-frame', turnId: 't1', stepId: 's1' };
  const root = { source, path: ['input'], revision: 'input-root', kind: 'object' as const, offset: 0, total: 2 };
  const child = { source, path: ['input', 'prompt'], revision: 'prompt-text', kind: 'text' as const, offset: 3, total: prompt.length };
  const content = vi.fn<NonNullable<SessionViewFacade['transcript']['content']>>(async ({ ref }) => ref.kind === 'object'
    ? { ref, value: { prompt: prompt.slice(0, 3), mode: 'complete' }, contentRefs: [child] }
    : { ref, value: prompt.slice(ref.offset, ref.offset + 32_000), contentRefs: [] });
  const { controller, deliver } = harness(undefined, content);
  await controller.open(); deliver(resetEvent('main', emptySnapshot({ items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 1, state: 'completed', frames: [{ kind: 'tool', frameId: source.id, toolCallId: 'input-call', name: 'AgentRun', state: 'done', input: {}, contentRefs: [root] }] }] }] }), 2));
  const copy = await controller.copyToolCallField('main', 'input-call', 'input');
  expect(JSON.parse(copy)).toEqual({ prompt, mode: 'complete' });
  expect(copy.length * 2).toBeGreaterThan(controller.contentMemoryReport().bodyBudget);
  expect(controller.contentMemoryReport().bodyBytes).toBe(0);
  expect(controller.contentRefsFor('main', source)).toEqual([root]);
  controller.close();
});


describe('automatic lightweight roster', () => {
  const children: NonNullable<SessionSnapshotResponse['subagents']> = Array.from({ length: 706 }, (_, index) => ({
    id: `child-${index}`, agent_id: `child-${index}`, session_id: session.id, kind: 'subagent',
    description: `Investigation ${index}`, label: `Investigation ${index}`, profile: 'researcher',
    model: 'fixture/model', status: 'completed', activity_status: 'completed', status_source: 'metadata',
    name_source: 'user_label', live: false, created_at: FIXED_AT,
  }));
  const ref: import('@kiki/transcript').ContentRef = { source: { kind: 'snapshot', id: '' }, revision: 'inventory-v1', path: ['subagents'], kind: 'array', offset: 4, total: 706 };
  const counts = { total: 707, subagents: 706, completed: 706, failed: 0, cancelled: 0, active: 0, idle: 0, unknown: 0 };
  const initial: SessionSnapshotResponse = { as_of_seq: 1, epoch: 'e', session, in_flight_turn: null, messages: { items: [], has_more: false },
    pending_approvals: [], pending_questions: [], subagents: children.slice(0, 4), agent_counts: counts, contentRefs: [ref] };

  it('publishes the shell then follows bounded metadata pages automatically, retaining row order without child bodies', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const content = vi.fn(async ({ ref: requested }: { ref: import('@kiki/transcript').ContentRef }) => {
      await gate;
      const offset = Math.min(requested.offset + 20, 706);
      return { ref: requested, value: children.slice(requested.offset, offset), contentRefs: [], next: offset < 706 ? { ...requested, offset } : undefined };
    });
    const { controller, view } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue(initial);
    await controller.open();
    expect(controller.getState().agentCounts).toEqual(counts);
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    release();
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents).toHaveLength(706), { timeout: 5000 });
    expect(controller.getState().snapshotSubagents.map((row) => row.id)).toEqual(children.map((row) => row.id));
    expect(controller.getForest()?.byId['child-633']).toMatchObject({ label: 'Investigation 633', status: 'completed', busy: false });
    expect(content).toHaveBeenCalledTimes(Math.ceil((706 - 4) / 20));
    expect(content.mock.calls.every(([input]) => input.ref.path.length === 1 && input.ref.path[0] === 'subagents')).toBe(true);
    expect(view.transcript.page).not.toHaveBeenCalled();
    expect(controller.getAgentState('child-633').loaded).toBe(false);
    expect(controller.getState().contentRefs).toEqual([]);
    controller.close();
  });

  it('automatically reloads a changed root roster revision at offset64 and completes706 on the same attachment', async () => {
    const { RPCError } = await import('@kiki/klient/session-view');
    const freshRef = { ...ref, revision: 'inventory-v2' };
    const freshRows = children.map((row) => row.id === 'child-633' ? { ...row, label: 'Recovered recorded name' } : row);
    const content = vi.fn(async ({ ref: requested }: { ref: import('@kiki/transcript').ContentRef }) => {
      if (requested.revision === ref.revision && requested.offset === 64) throw new RPCError(40922, 'Content changed; reload its preview before continuing.');
      const offset = Math.min(requested.offset + 20, 706);
      return { ref: requested, value: freshRows.slice(requested.offset, offset), contentRefs: [], next: offset < 706 ? { ...requested, offset } : undefined };
    });
    const { controller, view } = harness(undefined, content);
    const subscribe = vi.spyOn(view, 'subscribe');
    const sizes: number[] = [];
    controller.subscribe(() => { sizes.push(controller.getState().snapshotSubagents.length); });
    vi.mocked(view.snapshot).mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, contentRefs: [freshRef] });
    await controller.open();
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents).toHaveLength(706), { timeout: 2000 });
    expect(view.snapshot).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(sizes).toContain(64);
    expect(sizes.slice(sizes.indexOf(64)).every((size) => size >= 64)).toBe(true);
    expect(view.transcript.page).not.toHaveBeenCalled();
    expect(controller.getForest()?.byId['child-633']).toMatchObject({ label: 'Recovered recorded name', status: 'completed', statusSource: 'metadata', nameSource: 'user_label', busy: false });
    expect(controller.getState().cursor).toEqual({ seq: 1, epoch: 'e' });
    expect(controller.getState().agentCounts).toEqual(counts);
    expect(controller.getState().contentRefs).toEqual([]);
    expect(Object.values(controller.getState().detailLoads).some((load) => load.status === 'error')).toBe(false);
    controller.close();
  });

  it('continues after a fresh snapshot restores the same root reference following a transient revision failure', async () => {
    const { RPCError } = await import('@kiki/klient/session-view');
    let stale = true;
    const content = vi.fn(async ({ ref: requested }: { ref: import('@kiki/transcript').ContentRef }) => {
      if (stale) { stale = false; throw new RPCError(40922, 'Content changed'); }
      const offset = Math.min(requested.offset + 20, 706);
      return { ref: requested, value: children.slice(requested.offset, offset), contentRefs: [], next: offset < 706 ? { ...requested, offset } : undefined };
    });
    const { controller, view } = harness(undefined, content);
    vi.mocked(view.snapshot).mockImplementation(async () => ({ ...initial }));
    await controller.open();
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents).toHaveLength(706), { timeout: 1000 });
    expect(view.snapshot).toHaveBeenCalledTimes(2);
    expect(content).toHaveBeenCalledTimes(37);
    controller.close();
  });

  it('bounds root revision recovery without progress and allows an explicit retry to resume automatically', async () => {
    const { RPCError } = await import('@kiki/klient/session-view');
    let changed = true;
    let revision = 0;
    const content = vi.fn(async ({ ref: requested }: { ref: import('@kiki/transcript').ContentRef }) => {
      if (changed) throw new RPCError(40922, 'Content changed');
      const offset = Math.min(requested.offset + 20, 706);
      return { ref: requested, value: children.slice(requested.offset, offset), contentRefs: [], next: offset < 706 ? { ...requested, offset } : undefined };
    });
    const { controller, view } = harness(undefined, content);
    vi.mocked(view.snapshot).mockImplementation(async () => ({ ...initial, contentRefs: [{ ...ref, revision: `revision-${revision++}` }] }));
    await controller.open();
    await vi.waitFor(() => expect(Object.values(controller.getState().detailLoads).some((load) => load.status === 'error')).toBe(true));
    expect(view.snapshot).toHaveBeenCalledTimes(4);
    expect(content).toHaveBeenCalledTimes(4);
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    changed = false;
    const retryRef = controller.getState().contentRefs?.find((entry) => entry.kind === 'array' && entry.path[0] === 'subagents');
    expect(retryRef).toBeDefined();
    if (retryRef === undefined) throw new Error('Missing roster retry reference');
    await controller.loadContentSegment('main', retryRef);
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents).toHaveLength(706));
    expect(view.snapshot).toHaveBeenCalledTimes(4);
    controller.close();
  });

  it('does not apply a revision recovery snapshot after the attachment closes', async () => {
    const { RPCError } = await import('@kiki/klient/session-view');
    const content = vi.fn(async () => { throw new RPCError(40922, 'Content changed'); });
    const { controller, view } = harness(undefined, content);
    let release!: (snapshot: SessionSnapshotResponse) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(view.snapshot).mockResolvedValueOnce(initial).mockImplementation((input) => {
      signal = input?.signal;
      return new Promise((resolve) => { release = resolve; });
    });
    await controller.open();
    await vi.waitFor(() => expect(view.snapshot).toHaveBeenCalledTimes(2));
    controller.close();
    expect(signal?.aborted).toBe(true);
    release({ ...initial, subagents: [...children], contentRefs: [] });
    await vi.waitFor(() => expect((controller as unknown as { rosterReadInFlight: boolean }).rosterReadInFlight).toBe(false));
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('keeps a changed nested roster text reference recoverable without reloading the root array', async () => {
    const { RPCError } = await import('@kiki/klient/session-view');
    const textRef = { ...ref, kind: 'text' as const, path: ['subagents', 0, 'label'], offset: 4, total: 30 };
    const content = vi.fn(async () => { throw new RPCError(40922, 'Content changed'); });
    const { controller, view } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue({ ...initial, contentRefs: [textRef] });
    await controller.open();
    expect(await controller.loadContentSegment('main', textRef)).toBe(false);
    expect(view.snapshot).toHaveBeenCalledTimes(1);
    expect(content).toHaveBeenCalledTimes(1);
    expect(controller.getState().contentRefs).toContainEqual(textRef);
    expect(Object.values(controller.getState().detailLoads)).toContainEqual({ status: 'error', message: 'Content changed' });
    controller.close();
  });

  it('rejects an old pending roster page after a newer live generation replaces the shell', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const content = vi.fn(async () => { await gate; return { ref, value: children.slice(4), contentRefs: [] }; });
    const { controller, view, deliver } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue(initial);
    await controller.open();
    deliver(resetEvent('main', emptySnapshot(), 1));
    await vi.waitFor(() => expect(content).toHaveBeenCalledTimes(1));
    vi.mocked(view.snapshot).mockResolvedValue({ ...initial, as_of_seq: 2, contentRefs: [],
      subagents: [{ ...children[0]!, activity_status: 'running', status_source: 'runtime', status: 'running', live: true, label: 'Resumed investigation', started_at: '2026-01-02T00:00:00.000Z' }],
      agent_counts: { total: 2, subagents: 1, completed: 0, failed: 0, cancelled: 0, active: 1, idle: 0, unknown: 0 } });
    deliver(opsEvent('main', [{ op: 'task.upsert', task: { taskId: 'new-run', kind: 'subagent', agentId: 'child-0', state: 'running', detached: false, outputTail: '', startedAt: '2026-01-02T00:00:00.000Z' } }], 2));
    await vi.waitFor(() => expect(controller.getState().snapshotSubagents[0]?.label).toBe('Resumed investigation'));
    release();
    await vi.waitFor(() => expect(Object.values(controller.getState().detailLoads).every((load) => load.status !== 'loading')).toBe(true));
    expect(controller.getState().snapshotSubagents).toHaveLength(1);
    expect(controller.getState().snapshotSubagents[0]).toMatchObject({ label: 'Resumed investigation', activity_status: 'running', live: true });
    expect(controller.getForest()?.byId['child-0']).toMatchObject({ status: 'running', busy: true });
    expect(controller.getState().agentCounts?.total).toBe(2);
    controller.close();
  });

  it('stops on a stalled roster segment and keeps its retryable reference rather than spinning', async () => {
    const content = vi.fn(async () => ({ ref, value: [], next: ref, contentRefs: [] }));
    const { controller, view } = harness(undefined, content);
    vi.mocked(view.snapshot).mockResolvedValue(initial);
    await controller.open();
    await vi.waitFor(() => expect(Object.values(controller.getState().detailLoads)).toContainEqual({ status: 'error', message: 'Content segment did not advance its reference' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(content).toHaveBeenCalledTimes(1);
    expect(controller.getState().snapshotSubagents).toHaveLength(4);
    expect(controller.getState().contentRefs).toContainEqual(ref);
    controller.close();
  });
});
