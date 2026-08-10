/**
 * draft-flow — starts with zero sessions. The proof opens /new, types into
 * the draft composer and sends: the app lazily creates the session, routes
 * to /s/:id, and the answer streams in. Proves the new-session-as-page
 * flow end to end.
 */

import {
  commitAssistant,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const ANSWER = 'Here is the fixture answer from the draft flow.';

export default {
  sessions: [],
  snapshots: {},
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, ANSWER, { per: 20, delay: 25 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    turnEnd(1),
    commitAssistant('$SID', ANSWER),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
