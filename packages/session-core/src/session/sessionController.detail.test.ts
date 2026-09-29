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

function harness(detail: SessionViewFacade['transcript']['detail']) {
  let signal: ((value: SessionViewSignal) => void) | undefined;
  const view = {
    snapshot: vi.fn(async () => ({ as_of_seq: 1, epoch: 'e', session, in_flight_turn: null }) as unknown as SessionSnapshotResponse),
    transcript: { page: vi.fn(), catchUp: vi.fn(), detail },
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
  return { controller, deliver };
}

const shellOf = (controller: SessionController) =>
  controller.getState().blocks.find((block): block is ShellBlock => block.kind === 'shell');

function taskDetail(outputTail: string): SessionViewTranscriptDetail {
  return { session_id: 'session_test', agent_id: 'main', kind: 'task', task: shellTask(outputTail, false) } as SessionViewTranscriptDetail;
}

describe('SessionController transcript detail', () => {
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
    const { controller, deliver } = harness(detail);
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
