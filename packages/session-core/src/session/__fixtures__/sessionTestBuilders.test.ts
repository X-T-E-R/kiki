import { describe, expect, it, vi } from 'vitest';

import type { SessionController } from '../sessionController';
import type { SessionEventFrame } from '../../wire';
import { deliverFrame, eventFrame } from './sessionTestBuilders';

function mockController(sessionId = 'session_test') {
  const handleSignal = vi.fn();
  return {
    controller: { sessionId, handleSignal } as unknown as SessionController,
    handleSignal,
  };
}

describe('deliverFrame', () => {
  it('emits historyRewritten only for edit_resend or regenerate frames with a string target_message_id', () => {
    const { controller, handleSignal } = mockController();

    deliverFrame(
      controller,
      eventFrame(
        {
          type: 'event.session.history_rewritten',
          reason: 'edit_resend',
          target_message_id: 'msg-42',
        } as SessionEventFrame['payload'],
        { seq: 15 },
      ),
    );
    expect(handleSignal).toHaveBeenLastCalledWith({
      type: 'historyRewritten',
      cursor: { seq: 15, epoch: 'epoch-1' },
      generation: 0,
      reason: 'edit_resend',
      targetMessageId: 'msg-42',
    });

    deliverFrame(
      controller,
      eventFrame(
        {
          type: 'event.session.history_rewritten',
          reason: 'regenerate',
          target_message_id: 'msg-99',
        } as SessionEventFrame['payload'],
        { seq: 16 },
      ),
    );
    expect(handleSignal).toHaveBeenLastCalledWith({
      type: 'historyRewritten',
      cursor: { seq: 16, epoch: 'epoch-1' },
      generation: 0,
      reason: 'regenerate',
      targetMessageId: 'msg-99',
    });
  });

  it('falls back to sessionCursorAdvanced for malformed or non-rewrite history_rewritten frames and ignores volatile frames', () => {
    const { controller, handleSignal } = mockController();

    deliverFrame(
      controller,
      eventFrame({ type: 'event.session.history_rewritten' } as SessionEventFrame['payload'], { seq: 17 }),
    );
    expect(handleSignal).toHaveBeenLastCalledWith({
      type: 'sessionCursorAdvanced',
      cursor: { seq: 17, epoch: 'epoch-1' },
      generation: 0,
    });

    deliverFrame(
      controller,
      eventFrame(
        {
          type: 'event.session.history_rewritten',
          reason: 'undo',
          target_message_id: 'msg-1',
        } as unknown as SessionEventFrame['payload'],
        { seq: 18 },
      ),
    );
    expect(handleSignal).toHaveBeenLastCalledWith({
      type: 'sessionCursorAdvanced',
      cursor: { seq: 18, epoch: 'epoch-1' },
      generation: 0,
    });

    deliverFrame(
      controller,
      eventFrame(
        {
          type: 'event.session.history_rewritten',
          reason: 'regenerate',
          target_message_id: 'msg-volatile',
        } as SessionEventFrame['payload'],
        { seq: 19, volatile: true },
      ),
    );
    expect(handleSignal).toHaveBeenCalledTimes(2);
  });
});
