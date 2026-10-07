/**
 * archived-conversations — archived sessions over two workspaces, one attached
 * family, and more rows than fit in one page. The two unarchived sessions are
 * what the page must never offer to delete.
 */

import { assistantMsg, sessionRecord, ts, userMsg } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const OTHER_WS = 'wd_fixture_archive_review';

const WORKSPACES = [
  { id: WS, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(90_000), last_opened_at: ts(3), session_count: 5, pinned: true },
  { id: OTHER_WS, root: 'C:/fixture/archive-review', name: 'Review desk', created_at: ts(60_000), last_opened_at: ts(9), session_count: 2, pinned: false },
];

const ROOT = 'session_fixture_arch_root';
const ATTACHED = 'session_fixture_arch_attached';
const SECOND_CHILD = 'session_fixture_arch_second_child';
const PROMOTED = 'session_fixture_arch_promoted';
const RELEASES = 'session_fixture_arch_releases';
const MIGRATION = 'session_fixture_arch_migration';
const LATE = 'session_fixture_arch_late';
const PARTIAL = 'session_fixture_arch_partial';
const STUCK = 'session_fixture_arch_stuck';

const LIVE = 'session_fixture_arch_live';
const LIVE_CHILD = 'session_fixture_arch_live_child';

// Enough older rows that the page's own page size (50) is a real page turn.
// Each one is titled after what it was about: a list that repeats six phrases
// is not a shape a reader can judge a layout against.
const BULK = 48;
const BULK_SUBJECTS = [
  'ingress router', 'ws reconnect storm', 'scope ownership ADR', 'flaky integration runs',
  'cron backoff model', 'read-model cold path', 'transcript compaction', 'workspace sweep',
  'plugin unload races', 'schema migration guard', 'search reindex window', 'terminal resize',
  'subagent lease expiry', 'usage rollup parity', 'session pin drift', 'ssh host key rotation',
];
const BULK_VERBS = ['Refactor', 'Debug', 'Draft the ADR on', 'Triage', 'Sketch', 'Audit'];
const BULK_AREAS = ['v2', '0.3.3', 'cold path', 'fanout', 'retention', 'rollout'];

function archived(id, title, minutesAgo, extra = {}) {
  return sessionRecord(id, { title, workspace_id: WS, updated_at: ts(minutesAgo), archived: true, ...extra });
}

export default {
  workspaces: WORKSPACES,
  sessions: [
    // The family: archiving the parent took its attached conversation with it.
    archived(ROOT, 'Rework the transcript store', 26, {
      message_count: 184, last_seq: 412, metadata: { cwd: 'C:/fixture/workshop' },
    }),
    archived(ATTACHED, 'Rewrite the turn-cursor reader', 24, {
      message_count: 61, last_seq: 138,
      metadata: { cwd: 'C:/fixture/workshop', created_by_session_id: ROOT },
    }),
    // A second attached member, so a family delete that loses more than one is
    // a shape the page has to survive.
    archived(SECOND_CHILD, 'Second attached reader', 25, {
      message_count: 33, last_seq: 77,
      metadata: { cwd: 'C:/fixture/workshop', created_by_session_id: ROOT },
    }),
    // Promoted to the top level in the sidebar, so a delete of its parent
    // holds it back and it stays listed.
    archived(PROMOTED, 'Standalone: memory-timeline 033 review', 20, {
      workspace_id: OTHER_WS, message_count: 47, last_seq: 96,
      metadata: { cwd: 'C:/fixture/archive-review' },
    }),
    archived(RELEASES, 'Release notes for 0.3.3', 12, {
      message_count: 23, last_seq: 51, metadata: { cwd: 'C:/fixture/releases' },
    }),
    archived(MIGRATION, 'kap-server read-model migration plan', 8, {
      workspace_id: OTHER_WS, message_count: 132, last_seq: 288,
      metadata: { cwd: 'C:/fixture/archive-review' },
    }),
    archived(LATE, 'Old: TUI parity checklist', 300, {
      message_count: 9, last_seq: 22, metadata: { cwd: 'C:/fixture/releases' },
    }),
    archived(PARTIAL, 'Nightly sweep triage', 600, {
      message_count: 74, last_seq: 165, metadata: { cwd: 'C:/fixture/workshop' },
    }),
    archived(STUCK, 'Break the connection while deleting', 900, {
      message_count: 12, last_seq: 30, metadata: { cwd: 'C:/fixture/workshop' },
    }),
    // The rest of a real archive: enough older conversations that the page's
    // own page size is a real page turn, not a formality. Without these, every
    // archived row fits in one read and "load older" never appears.
    ...Array.from({ length: BULK }, (_, index) => archived(
      `session_fixture_arch_bulk_${String(index).padStart(3, '0')}`,
      `${BULK_VERBS[index % BULK_VERBS.length]} ${BULK_SUBJECTS[index % BULK_SUBJECTS.length]} (${BULK_AREAS[Math.floor(index / BULK_SUBJECTS.length) % BULK_AREAS.length]})`,
      1_200 + index * 37,
      {
        message_count: 4 + (index % 60), last_seq: 8 + index,
        ...(index % 3 === 0 ? { workspace_id: OTHER_WS, metadata: { cwd: 'C:/fixture/archive-review' } } : {}),
      },
    )),
    // Never archived. Clearing the archive must leave both in place.
    sessionRecord(LIVE, {
      title: 'Live: ship the archive page',
      workspace_id: WS, updated_at: ts(3), message_count: 40, last_seq: 77,
      metadata: { cwd: 'C:/fixture/workshop' },
    }),
    sessionRecord(LIVE_CHILD, {
      title: 'Live: subagent for the proof',
      workspace_id: WS, updated_at: ts(2), message_count: 6, last_seq: 12,
      metadata: { cwd: 'C:/fixture/workshop', created_by_session_id: LIVE },
    }),
  ],
  snapshots: {
    // An archived conversation is still readable: this is the one the proof
    // opens, and its transcript has to come back through the normal read path.
    [RELEASES]: {
      messages: [
        userMsg(RELEASES, 'Draft the 0.3.3 release notes.', 40),
        assistantMsg(RELEASES, ['Started from the merged changes since 0.3.2. The headline items are the archived-conversation routes, the session-title moments, and the cron queue modes.'], 38),
        userMsg(RELEASES, 'Keep it to one screen.', 36),
        assistantMsg(RELEASES, ['Trimmed. Kept: archived conversations, session titles, cron queue modes, and the read-model migration note.'], 34),
      ],
      has_more: false,
    },
    [ROOT]: {
      messages: [
        userMsg(ROOT, 'The transcript store keeps the whole turn in memory.', 200),
        assistantMsg(ROOT, ['Agreed. Splitting it into a per-agent store and a reader should cut the cold-start cost.'], 198),
      ],
      has_more: false,
    },
    [LIVE]: {
      messages: [userMsg(LIVE, 'Where is the archive page?', 4)],
      has_more: false,
    },
  },
};