import { commitAssistant, sessionRecord, streamSteps, turnEnd } from './helpers.mjs';

const SID = 'session_fixture_resync_hold';

/**
 * Bounded resync: the walker holds the /snapshot route with playwright route
 * interception, triggers resync_required, and proves the client keeps exactly
 * one snapshot request in flight (no retry storm), shows the resync state,
 * and recovers cleanly when the route is released.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: resync hold' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'Hold my snapshot.' } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    ...streamSteps('assistant.delta', 1, 'Settled before the hold.', { per: 40, delay: 5 }),
    turnEnd(1),
    // Journal the assistant text so the post-resync snapshot still carries it.
    commitAssistant('$SID', 'Settled before the hold.'),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
  ],
};
