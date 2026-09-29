/**
 * worktrees — worktree isolation, first batch. One Git workspace (workshop)
 * and one plain folder (notes). Sessions: an ordinary one, an active worktree
 * session (clean, long branch name), and three archived worktree sessions:
 * dirty with unpushed work (2 days), clean and due for cleanup (10 days), and
 * one whose removal fails with the checkout kept (12 days, files busy).
 */

import { sessionRecord, ts } from './helpers.mjs';

const WS_GIT = 'wd_fixture_000000000000';
const WS_PLAIN = 'wd_fixture_000000000001';
const SOURCE = 'C:/fixture/workshop';
const HOME = 'C:/Users/fixture/.kiki/worktrees/1a2b3c4d';
const day = 86_400_000;

function worktreeSession(id, { title, branch, suffix, minutesAgo, archivedDaysAgo }) {
  const archived = archivedDaysAgo !== undefined;
  return sessionRecord(id, {
    title,
    updated_at: archived ? new Date(Date.now() - archivedDaysAgo * day).toISOString() : ts(minutesAgo ?? 3),
    archived,
    ...(archived ? { archived_at: new Date(Date.now() - archivedDaysAgo * day).toISOString() } : {}),
    metadata: { cwd: `${HOME}/${suffix}` },
    worktree: { worktree_id: `wt_${suffix}`, branch, source_root: SOURCE, base_ref: 'HEAD' },
  });
}

function record(suffix, sessionId, branch, { createdDaysAgo, state = 'ready', lastInspection, removal } = {}) {
  const at = Date.now() - (createdDaysAgo ?? 1) * day;
  return {
    id: `wt_${suffix}`, version: 1,
    repo: { fingerprint: '1a2b3c4d', commonDir: `${SOURCE}/.git`, sourceRoot: SOURCE, workspaceId: WS_GIT },
    path: `${HOME}/${suffix}`, branch, branchCreated: true,
    base: { mode: 'head', ref: 'HEAD', commit: '0f3c9a1' },
    owner: { kind: 'session', sessionId },
    state, createdAt: at, updatedAt: at,
    ...(lastInspection !== undefined ? { lastInspection } : {}),
    ...(removal !== undefined ? { removal } : {}),
  };
}

const ACTIVE = 'session_fixture_wt_active';
const DIRTY = 'session_fixture_wt_dirty';
const DUE = 'session_fixture_wt_due';
const BUSY = 'session_fixture_wt_busy';
const PLAIN = 'session_fixture_plain';

const cleanInspection = { inspectedAt: Date.now() - 3_600_000, failed: false, dirtyFiles: 0, untrackedFiles: 0, aheadOfBase: 0, unpushedCommits: 0, ignoredNonDisposable: [] };

export default {
  workspaces: [
    { id: WS_GIT, root: SOURCE, name: 'workshop', created_at: ts(600), last_opened_at: ts(1), session_count: 5, pinned: false },
    { id: WS_PLAIN, root: 'C:/fixture/notes', name: 'notes', created_at: ts(600), last_opened_at: ts(300), session_count: 0, pinned: false },
  ],
  gitRoots: [SOURCE],
  sessions: [
    sessionRecord(PLAIN, { title: 'Tidy the release checklist', updated_at: ts(1), metadata: { cwd: SOURCE } }),
    worktreeSession(ACTIVE, { title: 'Refactor auth middleware', branch: 'kiki/refactor-auth-middleware-and-session-tokens-a1b2c3', suffix: 'a1b2c3', minutesAgo: 4 }),
    worktreeSession(DIRTY, { title: 'Try the new parser', branch: 'kiki/try-new-parser-d4e5f6', suffix: 'd4e5f6', archivedDaysAgo: 2 }),
    worktreeSession(DUE, { title: 'Spike: streaming exports', branch: 'kiki/spike-streaming-9a8b7c', suffix: '9a8b7c', archivedDaysAgo: 10 }),
    worktreeSession(BUSY, { title: 'Bump build tooling', branch: 'kiki/bump-tooling-3c2d1e', suffix: '3c2d1e', archivedDaysAgo: 12 }),
  ],
  snapshots: {},
  worktrees: [
    record('a1b2c3', ACTIVE, 'kiki/refactor-auth-middleware-and-session-tokens-a1b2c3', { createdDaysAgo: 0.1, lastInspection: cleanInspection }),
    record('d4e5f6', DIRTY, 'kiki/try-new-parser-d4e5f6', { createdDaysAgo: 3 }),
    record('9a8b7c', DUE, 'kiki/spike-streaming-9a8b7c', { createdDaysAgo: 11, lastInspection: cleanInspection }),
    record('3c2d1e', BUSY, 'kiki/bump-tooling-3c2d1e', { createdDaysAgo: 13 }),
  ],
  worktreeInspections: {
    wt_d4e5f6: { dirtyFiles: 3, untrackedFiles: 1, aheadOfBase: 1, unpushedCommits: 1, ignoredNonDisposable: ['.env.local'] },
  },
  worktreeRemoveFailures: {
    wt_3c2d1e: 'failed_busy',
  },
};
