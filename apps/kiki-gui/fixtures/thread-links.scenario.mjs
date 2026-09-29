/**
 * thread-links — the current conversation linking another thread, plus a busy
 * session with two background bash tasks (the sidebar's background-task mark)
 * and one with a queued prompt. The current conversation's history carries a
 * sent message with a thread link and its `<thread_refs>` context block, the
 * way the GUI sends it: the timeline must show a chip, never the markup.
 */

import { assistantMsg, sessionRecord, ts, userMsg } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const CURRENT = 'session_fixture_tl_current';
const REFERENCED = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const QUEUED = 'session_fixture_tl_queued';
const UNTITLED = 'session_7c1d9e02-5a44-4b0e-9f7d-3e2a1b0c9d8e';

const sentWithRef = [
  `The upload retries in /s/${REFERENCED} look like the same race. Can you check whether its fix covers our case?`,
  '',
  '<thread_refs>',
  `<thread_ref id="${REFERENCED}" title="Fix the flaky upload test" workspace="workshop" workspace_id="${WS}" cwd="C:/fixture/workshop" status="running" updated_at="${ts(3)}"/>`,
  'The user linked the Kiki threads above. Read one with ThreadRead (ThreadList returns the host_id it needs) or search it with HistorySearch (scope=session, session_id=<id>).',
  '</thread_refs>',
].join('\n');

const task = (id, description, command, minutesAgo) => ({
  id,
  session_id: REFERENCED,
  kind: 'bash',
  description,
  status: 'running',
  command,
  created_at: ts(minutesAgo),
  started_at: ts(minutesAgo),
  run_in_background: true,
});

export default {
  workspaces: [
    { id: WS, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(600), last_opened_at: ts(1), session_count: 4, pinned: false },
  ],
  sessions: [
    sessionRecord(CURRENT, { title: 'Harden the upload pipeline', updated_at: ts(1), metadata: { cwd: 'C:/fixture/workshop' } }),
    sessionRecord(REFERENCED, {
      title: 'Fix the flaky upload test',
      busy: true,
      main_turn_active: false,
      updated_at: ts(3),
      metadata: { cwd: 'C:/fixture/workshop' },
    }),
    sessionRecord(QUEUED, {
      title: 'Draft the release notes',
      busy: true,
      main_turn_active: true,
      updated_at: ts(5),
      metadata: { cwd: 'C:/fixture/workshop' },
    }),
    sessionRecord(UNTITLED, { title: '', last_prompt: '', updated_at: ts(40), metadata: { cwd: 'C:/fixture/workshop' } }),
  ],
  snapshots: {
    [CURRENT]: {
      messages: [
        userMsg(CURRENT, sentWithRef, 8),
        assistantMsg(CURRENT, [
          'That thread is still running its fix. I read its last turn with ThreadRead: it serializes the retry through one upload queue, which is the same race we hit here, so we can reuse that change.',
        ], 7),
      ],
    },
    [REFERENCED]: {
      messages: [userMsg(REFERENCED, 'Find why the upload test flakes and fix it.', 30)],
      tasks: [
        task('task_fx_tl_viewer', 'live viewer on :5188', 'pnpm dev --port 5188', 20),
        task('task_fx_tl_rerun', 'rerun upload suite x50', 'pnpm vitest run upload --repeat 50', 6),
      ],
    },
    [QUEUED]: {
      messages: [userMsg(QUEUED, 'Collect the merged PRs for the release notes.', 12)],
      in_flight_turn: { turn_id: 2, assistant_text: 'Collecting merged PRs…', thinking_text: '', running_tools: [] },
      active_prompt: {
        prompt_id: 'prompt_fx_tl_active',
        user_message_id: 'um_fx_tl_active',
        status: 'running',
        content: [{ type: 'text', text: 'Collect the merged PRs for the release notes.' }],
        created_at: ts(5),
      },
      queued_prompts: [
        {
          prompt_id: 'prompt_fx_tl_q1',
          user_message_id: 'um_fx_tl_q1',
          status: 'queued',
          content: [{ type: 'text', text: 'Then group them by area' }],
          created_at: ts(4),
          append_timing: 'agent_idle',
          revision: 1,
        },
      ],
    },
  },
};
