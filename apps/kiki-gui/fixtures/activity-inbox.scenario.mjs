/**
 * activity-inbox — the Activity page and the sidebar's four row states in one
 * list: a session blocked on an approval, one blocked on a question, two that
 * finished (one completed, one failed) with events the viewer has not seen, one
 * still running, and one already caught up.
 *
 * "Already caught up" needs a local seen-mark, so the proof seeds
 * `kiki.sessionSeen.v1` with `session_fixture_act_read` at that session's
 * `last_seq`; without the seed that row renders as unread, which is also a
 * valid state to look at.
 */

import { assistantMsg, sessionRecord, ts, userMsg } from './helpers.mjs';

const BLOCKED = 'session_fixture_act_approval';
const ASKED = 'session_fixture_act_question';
const DONE = 'session_fixture_act_done';
const FAILED = 'session_fixture_act_failed';
const RUNNING = 'session_fixture_act_running';
const READ = 'session_fixture_act_read';

const created = new Date().toISOString();
const expires = new Date(Date.now() + 23 * 3600_000).toISOString();

function pair(sessionId, ask, answer, minutesAgo) {
  return [
    userMsg(sessionId, ask, minutesAgo + 1),
    assistantMsg(sessionId, [answer], minutesAgo),
  ];
}

export default {
  sessions: [
    sessionRecord(BLOCKED, {
      title: 'Migrate the search index',
      pending_interaction: 'approval',
      busy: true,
      updated_at: ts(38),
      last_seq: 24,
    }),
    sessionRecord(ASKED, {
      title: 'Pick a rollout window',
      pending_interaction: 'question',
      updated_at: ts(12),
      last_seq: 16,
    }),
    sessionRecord(FAILED, {
      title: 'Nightly integration sweep',
      last_turn_reason: 'failed',
      updated_at: ts(4),
      last_seq: 31,
    }),
    sessionRecord(DONE, {
      title: 'Rewrite the onboarding copy',
      last_turn_reason: 'completed',
      updated_at: ts(21),
      last_seq: 12,
    }),
    sessionRecord(RUNNING, {
      title: 'Backfill usage rollups',
      busy: true,
      updated_at: ts(1),
      last_seq: 9,
    }),
    sessionRecord(READ, {
      title: 'Tidy the release checklist',
      last_turn_reason: 'completed',
      updated_at: ts(90),
      last_seq: 7,
    }),
  ],
  snapshots: {
    [BLOCKED]: {
      messages: pair(BLOCKED, 'Move the index to the new analyzer.', 'I need approval to drop the old index first.', 38),
      pending_approvals: [
        {
          approval_id: 'appr_act_1',
          session_id: BLOCKED,
          turn_id: 1,
          tool_call_id: 'call_act_1',
          tool_name: 'Bash',
          action: 'search-index drop --name legacy',
          tool_input_display: { kind: 'command', command: 'search-index drop --name legacy' },
          created_at: created,
          expires_at: expires,
        },
      ],
    },
    [ASKED]: {
      messages: pair(ASKED, 'Schedule the rollout.', 'Which window should I take?', 12),
      pending_questions: [
        {
          question_id: 'q_act_1',
          session_id: ASKED,
          turn_id: 1,
          questions: [
            {
              question_id: 'q_act_1_a',
              question: 'Which rollout window?',
              header: 'Rollout',
              multi_select: false,
              options: [
                { option_id: 'o1', label: 'Tonight, 23:00' },
                { option_id: 'o2', label: 'Saturday morning' },
              ],
            },
          ],
          created_at: created,
          expires_at: expires,
        },
      ],
    },
    [FAILED]: {
      messages: pair(FAILED, 'Run the integration sweep.', 'Two suites failed on the auth fixture.', 4),
    },
    [DONE]: {
      messages: pair(DONE, 'Rewrite the onboarding copy.', 'Done — three screens rewritten, shorter and plainer.', 21),
    },
    [RUNNING]: {
      messages: pair(RUNNING, 'Backfill the usage rollups.', 'Working through the backlog now.', 1),
    },
    [READ]: {
      messages: pair(READ, 'Tidy the release checklist.', 'Trimmed it to the steps we actually run.', 90),
    },
  },
};
