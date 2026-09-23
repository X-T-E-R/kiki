import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_queue';

const done = (turnId) => [
  { frame: { type: 'turn.ended', payload: { turnId, reason: 'completed', durationMs: 400 } } },
  { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
  { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
];

/**
 * Queue visibility: prompt A parks on a release gate; prompt B submitted
 * while A runs must surface immediately with a Queued marker, promote to
 * running when A finishes, and support cancellation while parked.
 *
 * A's turn holds its first step open until an accepted steer (or a release)
 * opens the next one, which is where a steered message becomes durable context
 * — mirroring the engine, where a managed steer is only a header.
 *
 * Turn ids come from a module counter so repeated prompts never reuse one —
 * matches the server's per-session monotonic turn numbering.
 */
let turnCounter = 0;

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: queue' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  onPrompt: (text) => {
    turnCounter += 1;
    const turnId = turnCounter;
    if (text.startsWith('A:')) {
      return [
        { frame: { type: 'turn.started', payload: { turnId, origin: { kind: 'user' }, prompt: text } } },
        { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
        { frame: { type: 'assistant.delta', offset: 0, payload: { turnId, delta: 'A holds the floor.' } } },
        { frame: { type: 'assistant.delta', offset: 18, payload: { turnId, delta: ' A is done.' } } },
        // A holds step 1 open until its next step is warranted: either the
        // operator releases the turn or an accepted steer opens the step the
        // steered message belongs in. That boundary is the only place a queued
        // prompt can turn into durable context — its receipt never paints.
        { waitFor: 'advance' },
        { frame: { type: 'turn.step.completed', payload: { turnId, step: 1 } } },
        { frame: { type: 'turn.step.started', payload: { turnId, step: 2 } } },
        { waitFor: 'release' },
        ...done(turnId),
      ];
    }
    return [
      { frame: { type: 'turn.started', payload: { turnId, origin: { kind: 'user' }, prompt: text } } },
      { frame: { type: 'assistant.delta', offset: 0, payload: { turnId, delta: 'B runs after A.' } } },
      ...done(turnId),
    ];
  },
};
