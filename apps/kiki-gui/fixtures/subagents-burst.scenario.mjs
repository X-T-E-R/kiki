import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_subagents_burst';

/**
 * Hidden-child isolation: the walker fires an on-demand burst of child-agent
 * deltas (control action `burst`) while a MutationObserver watches the main
 * page — child frames must land in the scoped per-agent store without
 * republishing the main transcript. The agent page afterwards proves the
 * frames were captured.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: subagents burst' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
};
