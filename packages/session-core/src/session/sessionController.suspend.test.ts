import { describe, expect, it, vi } from 'vitest';

import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { SessionViewFacade, SessionViewSignal, SessionViewSubscribeInput } from '@kiki/klient/session-view';

import type { SessionTransport } from '../transport';
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
  return { controller, attachments, read, deliver };
}

describe('SessionController suspend / resume', () => {
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

    controller.resume();
    expect(controller.suspended).toBe(false);
    expect(attachments).toHaveLength(2);
    expect(attachments[1]!.input.sessionCursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    expect(attachments[1]!.input.transcriptSince).toEqual({ main: { seq: 3, epoch: 'epoch-canonical' } });
    // The retained window is visible before any server round trip completes.
    expect(controller.getState().blocks.length).toBeGreaterThan(0);
    await vi.waitFor(() => { expect(controller.getState().session?.title).toBe('Renamed'); });
    expect(read).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('matches a freshly opened view after suspend, resume and catch-up', async () => {
    const parked = harness();
    await parked.controller.open();
    parked.deliver(resetEvent('main', userTurnSnapshot({ assistantText: 'Hello' }), 3));
    parked.controller.suspend();
    parked.controller.resume();
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
    controller.resume();
    await vi.waitFor(() => { expect(attachments).toHaveLength(1); });
    expect(controller.getState().loaded).toBe(true);
    controller.close();
  });
});
