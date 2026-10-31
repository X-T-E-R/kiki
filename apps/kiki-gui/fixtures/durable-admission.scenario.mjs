import { commitAssistant, sessionRecord, streamSteps, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_durable_admission';
const HELD_SID = 'session_fixture_durable_admission_held';

/**
 * Durable admission as a saved session sees it (scripts/fixture-admission.mjs).
 *
 * - An ordinary send restores briefly and is admitted: the bubble only ever
 *   shows its sending state.
 * - "Pick up where we left off." restores for 9 s in line behind another
 *   session, long enough for the slow line to appear.
 * - The held session opens with one message the server could not admit and
 *   one duplicate copy; both keep their decision on the bubble.
 */
const ANSWER = 'Done. Nothing else needed.';
const reply = (text) => [
  { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' } } } },
  workChanged(true),
  ...streamSteps('assistant.delta', 1, text, { per: 12, delay: 20 }),
  turnEnd(1),
  commitAssistant('$SID', text),
  { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
  workChanged(false),
];

export default {
  sessions: [
    sessionRecord(SID, { title: 'Fixture: durable admission' }),
    sessionRecord(HELD_SID, { title: 'Fixture: held admission' }),
  ],
  snapshots: {
    [SID]: { messages: [], has_more: false },
    [HELD_SID]: { messages: [], has_more: false },
  },
  durableAdmission: {
    defaultRestoreMs: 500,
    resumeMs: 30_000,
    rules: [
      { match: 'Pick up where we left off.', restoreMs: 9000, queuePosition: 2 },
      // A live send the server saves but cannot admit: the message stays on
      // its bubble with a retry instead of returning to the composer.
      { match: 'Try the flaky restore.', restoreMs: 800, outcome: 'failed' },
    ],
    seed: [
      {
        session_id: HELD_SID, prompt_id: 'held-failed', user_message_id: 'held-failed', status: 'queued', admission: 'failed',
        admission_error: { code: 40903, message: 'Message restoration timed out.' },
        content: [{ type: 'text', text: 'Summarize the open review comments.' }], created_at: '2026-01-01T09:00:00.000Z',
      },
      {
        session_id: HELD_SID, prompt_id: 'held-duplicate', user_message_id: 'held-duplicate', status: 'queued', admission: 'held',
        admission_duplicate_of: 'held-failed',
        content: [{ type: 'text', text: 'Summarize the open review comments.' }], created_at: '2026-01-01T09:00:05.000Z',
      },
    ],
  },
  onPrompt: () => reply(ANSWER),
};
