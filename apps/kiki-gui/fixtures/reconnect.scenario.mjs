/**
 * reconnect — a slow two-segment stream with journal commits between
 * segments. The proof drops the WS mid-segment, lets the script run on,
 * then triggers `resync` (epoch bump): the client refetches the snapshot
 * (which contains the committed segments) and continues — each segment
 * appears exactly once.
 */

import {
  commitAssistant,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_reconnect';

const SEGMENT_A = 'Segment A — this part streamed live before the drop.';
const SEGMENT_B = 'Segment B — this part landed while the socket was down.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: reconnect' })],
  snapshots: { [SID]: { messages: [] } },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, SEGMENT_A, { per: 14, delay: 90 }),
    { delay: 200 },
    commitAssistant('$SID', SEGMENT_A),
    // Segment B streams slowly; the proof drops the WS somewhere in here.
    ...streamSteps('assistant.delta', 1, SEGMENT_B, { per: 8, delay: 260 }),
    commitAssistant('$SID', SEGMENT_B),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    turnEnd(1),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
