import { describe, expect, it, vi } from 'vitest';

import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { SessionViewFacade, SessionViewSignal, SessionViewSubscribeInput } from '@kiki/klient/session-view';

import type { SessionTransport } from '../transport';
import { readInHistoryLane } from './historyReadLane';
import { SessionController } from './sessionController';
import { appendOps, opsEvent, resetEvent, userTurnSnapshot } from './__fixtures__/canonicalTranscript';

const session = {
  id: 'session_test',
  workspace_id: 'wd_test_000000000000',
  title: 'Test',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  busy: false,
  metadata: { cwd: 'C:/tmp' },
  agent_config: { model: '' },
  usage: {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0,
  },
  permission_rules: [],
  message_count: 0,
  last_seq: 0,
} as unknown as SessionSnapshotResponse['session'];

function snapshot(overrides: Partial<SessionSnapshotResponse> = {}): SessionSnapshotResponse {
  return { as_of_seq: 10, epoch: 'epoch-1', session, in_flight_turn: null, ...overrides } as SessionSnapshotResponse;
}

interface Attachment {
  readonly input: SessionViewSubscribeInput;
  readonly signal: (signal: SessionViewSignal) => void;
  closed: boolean;
}

function harness(read = vi.fn(async () => snapshot()), detail?: SessionViewFacade['transcript']['detail']) {
  const attachments: Attachment[] = [];
  const view: SessionViewFacade = {
    snapshot: read,
    transcript: {
      page: vi.fn(),
      catchUp: vi.fn(),
      detail,
    } as unknown as SessionViewFacade['transcript'],
    subscribe: (input, onSignal) => {
      const attachment: Attachment = { input, signal: onSignal, closed: false };
      attachments.push(attachment);
      return {
        updateSessionCursor: vi.fn(),
        setTranscriptGrades: vi.fn(),
        updateTranscriptCursor: vi.fn(),
        restart: vi.fn(),
        nudge: vi.fn(),
        close: () => { attachment.closed = true; },
      };
    },
  };
  const scheduler = { schedule: (callback: () => void) => { callback(); return 0; }, cancel: () => {} };
  const controller = new SessionController({} as SessionTransport, view, 'session_test', { scheduler });
  const deliver = (event: Parameters<SessionController['handleTranscript']>[0]) => {
    attachments.at(-1)!.signal({ type: 'transcript', event, generation: 1 });
  };
  return { controller, attachments, read, deliver, catchUp: view.transcript.catchUp };
}

describe('SessionController suspend / resume', () => {
  it('requests a baseline rather than catching up detail from an incomplete summary', async () => {
    const { controller, attachments, deliver, read, catchUp } = harness();
    await controller.open();
    const full = userTurnSnapshot({ assistantText: 'restored detail' });
    const summary = { ...full, items: full.items.map((item) => item.kind === 'turn' ? { ...item, steps: [] } : item) };
    const reset = resetEvent('child-1', summary, 3);
    if (reset.type !== 'transcript.reset') throw new Error('Expected reset fixture');
    deliver({ ...reset, grade: 'turn' });
    controller.setFocusedAgent('child-1');
    deliver(opsEvent('child-1', appendOps(15, ' missing baseline'), 4));
    await vi.waitFor(() => expect(attachments).toHaveLength(2));
    expect(read).toHaveBeenCalledTimes(2);
    expect(catchUp).not.toHaveBeenCalled();
    expect(attachments[1]!.input.transcriptSince).toBeUndefined();
    expect(controller.getAgentState('child-1').transcriptReady).toBe(false);
    deliver(resetEvent('child-1', full, 4));
    expect(controller.getAgentState('child-1').transcriptReady).toBe(true);
    controller.close();
  });

  it('omits a summary cursor when a new attachment demands detail and waits for its baseline', async () => {
    const { controller, attachments, deliver } = harness();
    await controller.open();
    const full = userTurnSnapshot({ assistantText: 'restored detail' });
    const summary = { ...full, items: full.items.map((item) => item.kind === 'turn' ? { ...item, steps: [] } : item) };
    const summaryReset = resetEvent('child-1', summary, 3);
    if (summaryReset.type !== 'transcript.reset') throw new Error('Expected reset fixture');
    deliver({ ...summaryReset, grade: 'turn' });
    controller.suspend();
    controller.setFocusedAgent('child-1');
    await controller.resume();
    expect(attachments[1]!.input.transcriptSince?.['child-1']).toBeUndefined();
    expect(controller.getAgentState('child-1').transcriptReady).toBe(false);
    deliver(resetEvent('child-1', full, 3));
    expect(controller.getAgentState('child-1').transcriptReady).toBe(true);
    expect(JSON.stringify(controller.getAgentState('child-1').blocks)).toContain('restored detail');
    controller.close();
  });

  it('detaches the live view on suspend and keeps the rendered window', async () => {
    const { controller, attachments, deliver } = harness();
    await controller.open();
    deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Hello' }), 3));
    const before = controller.getState();
    expect(before.blocks.length).toBeGreaterThan(0);

    controller.suspend();
    expect(controller.suspended).toBe(true);
    expect(attachments[0]!.closed).toBe(true);
    // Signals from the detached subscription are ignored.
    attachments[0]!.signal({ type: 'transcript', event: opsEvent('main', appendOps(5, ' stale'), 4), generation: 1 });
    expect(controller.getState().blocks).toBe(before.blocks);
    expect(controller.residentBytes()).toBeGreaterThan(0);
    controller.close();
  });

  it('resumes from the retained cursors and refreshes the shell in the background', async () => {
    const read = vi.fn(async () => snapshot());
    const { controller, attachments, deliver } = harness(read);
    await controller.open();
    deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Hello' }), 3));
    controller.suspend();
    read.mockResolvedValueOnce(snapshot({ as_of_seq: 14, session: { ...session, title: 'Renamed' } }));

    const resumed = controller.resume();
    expect(controller.suspended).toBe(false);
    expect(attachments).toHaveLength(2);
    expect(attachments[1]!.input.sessionCursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    expect(attachments[1]!.input.transcriptSince).toEqual({ main: { seq: 3, epoch: 'epoch-canonical' } });
    // The retained window is visible before any server round trip completes.
    expect(controller.getState().blocks.length).toBeGreaterThan(0);
    await resumed;
    expect(controller.getState().session?.title).toBe('Renamed');
    expect(read).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('matches a freshly opened view after suspend, resume and catch-up', async () => {
    const parked = harness();
    await parked.controller.open();
    parked.deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Hello' }), 3));
    parked.controller.suspend();
    await parked.controller.resume();
    parked.deliver(opsEvent('main', appendOps(5, ' world'), 4));

    const fresh = harness();
    await fresh.controller.open();
    fresh.deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Hello' }), 3));
    fresh.deliver(opsEvent('main', appendOps(5, ' world'), 4));

    const texts = (controller: SessionController) => controller.getState().blocks
      .map((block) => ('text' in block ? block.text : block.kind));
    expect(texts(parked.controller)).toEqual(texts(fresh.controller));
    expect(texts(parked.controller).join(' ')).toContain('Hello world');
    parked.controller.close();
    fresh.controller.close();
  });

  it('reopens instead of reattaching when it was suspended before the first load', async () => {
    const read = vi.fn(() => new Promise<SessionSnapshotResponse>(() => {}));
    const { controller, attachments } = harness(read);
    void controller.open();
    controller.suspend();
    read.mockResolvedValueOnce(snapshot());
    await controller.resume();
    await vi.waitFor(() => { expect(attachments).toHaveLength(1); });
    expect(controller.getState().loaded).toBe(true);
    controller.close();
  });

  it('prioritizes high-priority timeline page reads ahead of queued background HistoryReadLane reads', async () => {
    const conn = {};
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const hold = (label: string) => () => new Promise<string>((resolve) => {
      order.push(`start:${label}`);
      gates.push(() => {
        order.push(`done:${label}`);
        resolve(label);
      });
    });

    // Fill all 3 concurrent slots with background reads from session A.
    const f1 = readInHistoryLane(conn, hold('bg-1'));
    const f2 = readInHistoryLane(conn, hold('bg-2'));
    const f3 = readInHistoryLane(conn, hold('bg-3'));
    // Queue two normal background reads behind them, then a high-priority initial timeline read for session B.
    const qNormal1 = readInHistoryLane(conn, hold('queued-normal-1'), undefined, 'normal');
    const qNormal2 = readInHistoryLane(conn, hold('queued-normal-2'), undefined, 'normal');
    const qHigh = readInHistoryLane(conn, hold('focused-timeline-page'), undefined, 'high');

    expect(order).toEqual(['start:bg-1', 'start:bg-2', 'start:bg-3']);
    // Release one slot: the high-priority timeline read must jump ahead of queued normal reads.
    gates.shift()!();
    await f1;
    await Promise.resolve();
    expect(order).toContain('start:focused-timeline-page');
    expect(order).not.toContain('start:queued-normal-1');

    while (gates.length > 0) {
      gates.shift()!();
      await Promise.resolve();
    }
    await Promise.all([f2, f3, qNormal1, qNormal2, qHigh]);
    expect(order.indexOf('start:focused-timeline-page')).toBeLessThan(order.indexOf('start:queued-normal-1'));
    expect(order.indexOf('start:queued-normal-1')).toBeLessThan(order.indexOf('start:queued-normal-2'));
  });

  it('cancels parked older history reads without closing a busy view subscription', async () => {
    const { controller, attachments, deliver } = harness();
    await controller.open();
    let aborted = false;
    (controller as unknown as { view: SessionViewFacade }).view.transcript.page = vi.fn<SessionViewFacade['transcript']['page']>(
      (_input, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      }),
    );
    deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Live busy turn' }), 3, true));

    const pendingOlder = controller.loadOlderHistory('main');
    await vi.waitFor(() => expect(controller.getState().loadingOlder).toBe(true));

    controller.cancelParkedReads();
    const outcome = await pendingOlder;
    expect(aborted).toBe(true);
    expect(outcome.kind).toBe('cancelled');
    expect(controller.getState().loadingOlder).toBe(false);
    expect(controller.suspended).toBe(false);
    expect(controller.parked).toBe(true);
    expect(attachments[0]!.closed).toBe(false);
    controller.close();
  });

  it('keeps contentReaders and lookupToolCall from re-entering HistoryReadLane while parked until unparked', async () => {
    const { controller, deliver } = harness();
    await controller.open();

    let structureCalls = 0;
    let structureAborts = 0;
    let toolCalls = 0;
    let toolAborts = 0;
    const view = (controller as unknown as { view: SessionViewFacade }).view;
    view.transcript.page = vi.fn<SessionViewFacade['transcript']['page']>(
      (_input, options) => {
        structureCalls += 1;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            structureAborts += 1;
            reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );
    view.transcript.detail = vi.fn<NonNullable<SessionViewFacade['transcript']['detail']>>(
      (_input, options) => {
        toolCalls += 1;
        const callNo = toolCalls;
        return new Promise((resolve, reject) => {
          if (callNo === 1) {
            options?.signal?.addEventListener('abort', () => {
              toolAborts += 1;
              reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            return;
          }
          resolve({
            session_id: 'session_test',
            agent_id: 'main',
            kind: 'tool',
            lookup: { status: 'not_found' },
          });
        });
      },
    );

    const partialSnap = userTurnSnapshot({ assistantText: 'Streaming busy turn' });
    const patchedSnap = {
      ...partialSnap,
      items: partialSnap.items.map((item) =>
        item.kind === 'turn' ? { ...item, stepsPartial: true } : item,
      ),
    };
    deliver(resetEvent('main', patchedSnap, 3, true));

    const reader = controller.beginContentRead('main', { kind: 'turn', id: 't1' }, ['steps']);
    await vi.waitFor(() => expect(structureCalls).toBe(1));

    const pendingTool = controller.lookupToolCall('main', 'tc_parked');
    await vi.waitFor(() => expect(toolCalls).toBe(1));

    // Parking the busy session aborts in-flight structure + tool reads cleanly.
    controller.cancelParkedReads();
    expect(controller.parked).toBe(true);
    expect(structureAborts).toBe(1);
    expect(toolAborts).toBe(1);
    await expect(pendingTool).rejects.toMatchObject({ name: 'AbortError' });

    // Live ops arriving while parked must NOT re-pump retained contentReaders into HistoryReadLane.
    deliver(opsEvent('main', appendOps(5, ' more live text'), 4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(structureCalls).toBe(1);

    // Unparking resumes pumping retained contentReaders and allows clean tool detail re-fetches.
    controller.unpark();
    expect(controller.parked).toBe(false);
    await vi.waitFor(() => expect(structureCalls).toBe(2));
    const retriedTool = await controller.lookupToolCall('main', 'tc_parked');
    expect(toolCalls).toBe(2);
    expect(retriedTool.status).toBe('not_found');

    reader.release();
    controller.close();
  });

  it('aborts in-flight tool detail reads on suspend() so switched-away idle sessions do not clog HistoryReadLane', async () => {
    const { controller } = harness();
    await controller.open();
    const view = (controller as unknown as { view: SessionViewFacade }).view;
    let toolAborts = 0;
    let toolCalls = 0;
    (view.transcript as { detail?: ReturnType<typeof vi.fn> }).detail = vi.fn(
      (_params: unknown, opts?: { signal?: AbortSignal }) => {
        toolCalls += 1;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            toolAborts += 1;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );
    const pendingTool = controller.lookupToolCall('main', 'tc_suspend');
    await vi.waitFor(() => expect(toolCalls).toBe(1));

    controller.suspend();
    expect(toolAborts).toBe(1);
    await expect(pendingTool).rejects.toMatchObject({ name: 'AbortError' });
    controller.close();
  });

  it('defers resync and rolls back pre-gap cursor when suspending during gap recovery after a later clean batch', async () => {
    const { controller, attachments, deliver, read, catchUp } = harness();
    type CatchUpResult = Awaited<ReturnType<SessionViewFacade['transcript']['catchUp']>>;
    let resolveCatchUp: ((value: CatchUpResult) => void) | undefined;
    vi.mocked(catchUp).mockImplementationOnce(
      () => new Promise<CatchUpResult>((resolve) => { resolveCatchUp = resolve; }),
    );

    await controller.open();
    deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'hello' }), 9));
    // Seq 10 hits an append gap (offset 10 > 'hello'.length === 5), starting catch-up.
    deliver(opsEvent('main', appendOps(10, ' end'), 10));
    await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(1));

    // Seq 11 applies cleanly (meta/marker) while catch-up is in flight, advancing live cursor to 11.
    deliver(opsEvent('main', [{
      op: 'marker.upsert',
      item: { kind: 'marker', markerId: 'm11', marker: 'notice', payload: { text: 'note' } },
    }], 11));

    const readsBeforeSuspend = read.mock.calls.length;
    const attachmentsBeforeResume = attachments.length;
    controller.suspend();

    // Resolving the aborted catch-up after suspend must be a no-op.
    resolveCatchUp?.({ session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', batches: [], through_seq: 10, complete: true, has_more: false });

    const resumePromise = controller.resume();
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(readsBeforeSuspend));
    await vi.waitFor(() => expect(attachments.length).toBeGreaterThan(attachmentsBeforeResume));
    // Re-attached subscription must not ask from seq 11 past the unrecovered seq 10 gap.
    const latestSince = attachments.at(-1)?.input.transcriptSince?.['main'];
    expect(latestSince === undefined || latestSince.seq <= 9).toBe(true);
    deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'hello mid end' }), 11));
    await resumePromise;
    expect(controller.getState().blocks).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'hello mid end' }));
    controller.close();
  });

  it('does not replay an older queued gap batch over newer recovered catch-up pages', async () => {
    const { controller, deliver, catchUp } = harness();
    const initial = userTurnSnapshot({ assistantText: 'hello' });
    const baseTurn = initial.items[0]!;
    if (baseTurn.kind !== 'turn') throw new Error('expected turn');
    const stepId = baseTurn.steps[0]!.stepId;
    const frameId = baseTurn.steps[0]!.frames[0]!.frameId;
    const reset = resetEvent('main', initial, 9);
    const epoch = (reset.type === 'transcript.reset' ? reset.cursor.epoch : undefined) ?? 'epoch-1';

    vi.mocked(catchUp).mockResolvedValueOnce({
      session_id: 'session_test',
      agent_id: 'main',
      epoch,
      batches: [
        {
          seq: 10,
          ops: [
            { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId, turnId: 't1', ordinal: 1, state: 'running' } },
            { op: 'append', target: { type: 'frame', turnId: 't1', stepId, frameId }, offset: 5, text: ' world' },
          ],
        },
        {
          seq: 11,
          ops: [
            { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId, turnId: 't1', ordinal: 1, state: 'completed' } },
          ],
        },
      ],
      through_seq: 11,
      complete: true,
      has_more: false,
    });

    await controller.open();
    const runningInitial = {
      ...initial,
      items: initial.items.map((item) => item.kind === 'turn'
        ? { ...item, state: 'running' as const, steps: item.steps.map((step) => ({ ...step, state: 'running' as const })) }
        : item),
    };
    deliver(resetEvent('main', runningInitial, 9));

    // Gap batch at seq 10 carries stale step.upsert(running) + gapped append.
    deliver(opsEvent('main', [
      { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId, turnId: 't1', ordinal: 1, state: 'running' } },
      ...appendOps(20, ' late'),
    ], 10));

    const readStepState = () => {
      const store = (controller as unknown as { main: { store?: { getTurn(id: string): { steps: Array<{ state: string }> } | undefined } } }).main.store;
      return store?.getTurn('t1')?.steps[0]?.state;
    };

    await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(readStepState()).toBe('completed'));

    // Live duplicate of seq 11 arrives after catch-up finished; step must stay completed.
    deliver(opsEvent('main', [
      { op: 'step.upsert', turnId: 't1', step: { kind: 'step', stepId, turnId: 't1', ordinal: 1, state: 'completed' } },
    ], 11));
    expect(readStepState()).toBe('completed');
    controller.close();
  });
});
