/**
 * memory-off — the shipped default: `[memory] enabled = false`. The sidebar
 * entry is still there, and opening it lands on the turn-on guide rather than
 * an empty console. One scenario per state so the off path can never regress
 * into "looks like a bug".
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_memory_off';
const WS_APP = 'wd_fixture_000000000000';

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 1, pinned: false },
  ],
  sessions: [sessionRecord(SID, { title: 'Fixture: memory off', workspace_id: WS_APP })],
  snapshots: { [SID]: { messages: [] } },
  memory: { enabled: false, approval: 'auto', budget: 2_000, workspaces: {} },
};
