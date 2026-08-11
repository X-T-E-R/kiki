/**
 * terminal — one idle session for the embedded-terminal walker. No seeded
 * PTYs: the walker drives the full lifecycle (empty state → create → type →
 * resize → tabs → kill → exit → restart → reload-reattach) against the
 * fixture's FakeTerminal echo shell.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_terminal';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: terminal' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
};
