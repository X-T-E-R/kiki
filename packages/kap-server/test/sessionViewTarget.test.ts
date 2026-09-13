import { describe, expect, it, vi } from 'vitest';
import type { SessionViewSignal } from '@kiki/klient';
import { SessionViewTarget } from '../src/transport/klient/sessionViewTarget';
import { SessionViewHttpConnection } from '../src/transport/klient/sessionViewHttp';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';

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

  it('preserves rewrite and epoch invalidation signals', () => {
    const signals: SessionViewSignal[] = [];
    const target = new SessionViewTarget('s1', (signal) => signals.push(signal));
    target.begin(2);
    target.replay({ ...durable(9), payload: { type: 'event.session.history_rewritten', reason: 'regenerate', target_message_id: 'message-1' } });
    target.sendControl({ type: 'resync_required', payload: { reason: 'epoch_changed', current_seq: 0, epoch: 'new-epoch' } });
    target.finish({ seq: 0, epoch: 'new-epoch' }, false);
    expect(signals[0]).toMatchObject({ type: 'historyRewritten', reason: 'regenerate', targetMessageId: 'message-1', generation: 2 });
    expect(signals[1]).toMatchObject({ type: 'resyncRequired', reason: 'epoch_changed', currentSessionCursor: { seq: 0, epoch: 'new-epoch' } });
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
    connection.receive({ type: 'view_attach', id: 'v1', sessionId: 's1', data: { generation: 1, input: { sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } } } });
    await vi.waitFor(() => { expect(resolveAttach).toBeDefined(); });
    connection.dispose();
    resolveAttach!(true);
    await vi.waitFor(() => { expect(broadcaster.unsubscribe).toHaveBeenCalled(); });
    expect(broadcaster.getBufferedSince).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});
