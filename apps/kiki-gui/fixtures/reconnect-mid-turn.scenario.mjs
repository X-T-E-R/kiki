import { commitAssistant, sessionRecord, streamSteps, turnEnd, turnStart, workChanged } from './helpers.mjs';

const SID = 'session_fixture_reconnect_mid_turn';

const PART_ONE = 'Part one streamed before the drop.';
const PART_TWO = 'Part two streamed during the blackout.';
const FULL = `${PART_ONE} ${PART_TWO}`;

// One cumulative-offset delta series with a release gate spliced into the
// middle: part one streams live, the walker drops the socket, and the rest of
// the turn (plus the journal commit) happens during the blackout — WITHOUT an
// epoch bump, so only the busy-at-drop resync can recover the full text.
const deltas = streamSteps('assistant.delta', 1, FULL, { per: 12, delay: 15 });
const midpoint = Math.ceil(deltas.length / 2);

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: reconnect mid-turn' })],
  snapshots: { [SID]: { messages: [] } },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    ...deltas.slice(0, midpoint),
    { waitFor: 'release' },
    ...deltas.slice(midpoint),
    commitAssistant('$SID', FULL),
    turnEnd(1),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
