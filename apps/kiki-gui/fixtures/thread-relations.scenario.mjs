/**
 * thread-relations — a session list carrying both kinds of relation, so the
 * sidebar's nesting can be proven in every view:
 *
 *   Release coordination            (plain root)
 *     ├ Docs pass                   ThreadCreate → created_by_session_id
 *     └ Changelog draft             ThreadCreate, from a subagent
 *   Migration spike                 (plain root)
 *     └ Migration spike — retry     fork → parent_session_id + child kind
 *   Orphan follow-up                created by a session that is NOT loaded,
 *                                   so the row stays top-level and says so.
 *
 * Two workspaces and one pinned root, because grouping by workspace and the
 * pinned bucket are exactly where nesting rules have to hold: a thread whose
 * creator sits in another bucket must not vanish.
 */

import { sessionRecord, ts, userMsg } from './helpers.mjs';

const WS_APP = 'wd_fixture_000000000000';
const WS_DOCS = 'wd_docs_site_000000000000';

const RELEASE = 'session_fixture_release';
const DOCS_THREAD = 'session_fixture_docs_thread';
const CHANGELOG_THREAD = 'session_fixture_changelog_thread';
const SPIKE = 'session_fixture_spike';
const SPIKE_RETRY = 'session_fixture_spike_retry';
const ORPHAN = 'session_fixture_orphan';
const PINNED = 'session_fixture_pinned';

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(9_000), last_opened_at: ts(3), session_count: 5, pinned: true },
    { id: WS_DOCS, root: 'C:/fixture/docs-site', name: 'docs-site', created_at: ts(9_000), last_opened_at: ts(40), session_count: 2, pinned: false },
  ],
  sessions: [
    sessionRecord(PINNED, {
      title: 'Weekly triage',
      workspace_id: WS_APP,
      updated_at: ts(400),
      metadata: { cwd: 'C:/fixture/workshop', 'kiki.pinned': true },
    }),
    sessionRecord(RELEASE, {
      title: 'Release coordination',
      workspace_id: WS_APP,
      updated_at: ts(6),
    }),
    sessionRecord(DOCS_THREAD, {
      title: 'Docs pass for 0.31',
      workspace_id: WS_DOCS,
      updated_at: ts(9),
      metadata: {
        cwd: 'C:/fixture/docs-site',
        created_by_session_id: RELEASE,
        created_by_agent_id: 'main',
      },
    }),
    sessionRecord(CHANGELOG_THREAD, {
      title: 'Changelog draft',
      workspace_id: WS_APP,
      updated_at: ts(14),
      busy: true,
      metadata: {
        cwd: 'C:/fixture/workshop',
        created_by_session_id: RELEASE,
        created_by_agent_id: 'writer',
      },
    }),
    sessionRecord(SPIKE, {
      title: 'Migration spike',
      workspace_id: WS_APP,
      updated_at: ts(50),
    }),
    sessionRecord(SPIKE_RETRY, {
      title: 'Migration spike — retry from turn 8',
      workspace_id: WS_APP,
      updated_at: ts(52),
      metadata: {
        cwd: 'C:/fixture/workshop',
        parent_session_id: SPIKE,
        child_session_kind: 'child',
      },
    }),
    sessionRecord(ORPHAN, {
      title: 'Follow-up on the audit thread',
      workspace_id: WS_DOCS,
      updated_at: ts(70),
      metadata: {
        cwd: 'C:/fixture/docs-site',
        // Deliberately not in this list: the row must stay top-level and name
        // the relation in its meta line instead of disappearing.
        created_by_session_id: 'session_fixture_not_loaded',
        created_by_agent_id: 'main',
      },
    }),
  ],
  snapshots: {
    [RELEASE]: { messages: [userMsg(RELEASE, 'Coordinate the 0.31 release: docs, changelog, and the migration spike.', 8)] },
    [DOCS_THREAD]: { messages: [userMsg(DOCS_THREAD, 'Review the docs for anything that still says npm.', 9)] },
  },
};
