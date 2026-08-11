/**
 * session-actions — one idle session with two completed turns. The walker
 * exports the archive (raw download), compacts, undoes the last turn (the
 * second exchange disappears after the resync), and forks into a copy.
 */

import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_actions';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: session actions' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'First exchange — kept after undo.', 40),
        assistantMsg(SID, ['First reply — survives the undo.'], 39),
        userMsg(SID, 'Second exchange — removed by undo.', 20),
        assistantMsg(SID, ['Second reply, undone.'], 19),
      ],
      has_more: false,
    },
  },
};
