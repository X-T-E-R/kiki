import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_reminder';

/**
 * Reminder peel: daemon-injected <system-reminder> envelopes ride user-role
 * messages (both embedded in the user's own text and as standalone parts).
 * The user bubble must show only the user's words; reminder content renders
 * as a dimmed, collapsed-by-default left-lane block.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: reminder' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        userMsg(
          SID,
          'Fix the flaky integration test.\n\n<system-reminder>\nThe same tool call has been repeated several times in a row. Before making your next call, write one sentence stating what new information you expect it to produce.\n</system-reminder>',
          4,
        ),
        assistantMsg(SID, ['Fixed — the flake was a missing await on the fixture client.'], 3),
        userMsg(
          SID,
          '<system-reminder>\nThe session crossed midnight while the turn was parked. Re-render relative dates before answering.\n</system-reminder>',
          2,
        ),
        assistantMsg(SID, ['Noted — dates re-rendered.'], 1),
      ],
    },
  },
};
