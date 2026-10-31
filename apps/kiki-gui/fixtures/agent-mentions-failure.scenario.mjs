/**
 * agent-mentions-failure — the composer `@` menu when the agent candidate load
 * fails: the menu shows a single readable line instead of crashing or hanging,
 * while the file group still lists.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_agent_mentions_fail';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: agent mentions (load failure)' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  fsEntries: [
    { path: 'README.md', name: 'README.md', kind: 'file' },
  ],
  // The fixture server returns this as the route's error envelope, so the
  // candidate query rejects and the menu falls back to its failure line.
  agentReferences: { error: 50000, message: 'agent references unavailable' },
  onPrompt: [],
};
