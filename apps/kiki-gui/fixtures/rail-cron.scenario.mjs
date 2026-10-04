/**
 * rail-cron — one conversation with four scheduled tasks of its own (three
 * live, one paused), plus a second conversation and a workspace-level task
 * that must never appear in its rail group. Drives the inspector's 本对话定时任务
 * block (default three rows, the rest behind one control, pause/resume,
 * empty state) and the /cron page's `?session=` scope.
 *
 * The session also carries a todo list and one running background task, so the
 * new block can be compared with its neighbours on the same page.
 *
 * `session_id` on every seeded task is what the real `GET /api/cron` narrows
 * on; the fixture hands back only the requested conversation's rows.
 */

import { assistantMsg, fid, sessionRecord, toolResultMsg, userMsg } from './helpers.mjs';

const SID = 'session_fixture_cron';
const OTHER = 'session_fixture_cron_other';
const WS = 'wd_fixture_000000000000';
const TODO_CALL = fid('call');

const TODO_ITEMS = [
  { title: 'Collect the overnight logs', status: 'completed' },
  { title: 'Schedule the daily digest', status: 'in_progress' },
  { title: 'Review the scheduled prompts', status: 'pending' },
];

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function cronTask(overrides) {
  return {
    session_id: SID,
    workspace_id: WS,
    cron: '0 9 * * *',
    human_schedule: 'Every day at 09:00',
    prompt_preview: 'Summarize the overnight logs.',
    next_fire_at: inMinutes(4),
    recurring: true,
    paused: false,
    age_days: 3,
    stale: false,
    created_at: minutesAgo(4_320),
    last_fired_at: minutesAgo(1_500),
    ...overrides,
  };
}

export default {
  sessions: [
    sessionRecord(SID, { title: 'Fixture: scheduled work', message_count: 3, last_seq: 3 }),
    sessionRecord(OTHER, { title: 'Fixture: another conversation', updated_at: minutesAgo(30) }),
  ],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'Schedule the daily digest, then keep an eye on the pending reviews.', 14),
        assistantMsg(SID, [
          { toolUse: { id: TODO_CALL, name: 'TodoWrite', input: { todos: TODO_ITEMS } } },
          'The digest runs every morning at 09:00. I also left a review reminder for tomorrow.',
        ], 12),
        toolResultMsg(SID, TODO_CALL, { kind: 'todo_list', items: TODO_ITEMS }, 12),
      ],
      tasks: [
        {
          id: fid('task'),
          session_id: SID,
          kind: 'bash',
          description: 'fixture log sweep',
          status: 'running',
          command: 'pnpm logs:sweep --since=24h',
          created_at: minutesAgo(3),
          started_at: minutesAgo(3),
          output_preview: 'reading .tmp/fixture/logs…\n2 files older than 24h',
          output_bytes: 512,
        },
      ],
    },
    [OTHER]: {
      messages: [
        userMsg(OTHER, 'Keep the market cache fresh.', 40),
        assistantMsg(OTHER, ['Reindexing it every hour.'], 39),
      ],
    },
  },
  cronTasks: [
    cronTask({
      id: 'cron_fixture_digest',
      prompt_preview: 'Summarize the overnight logs and post the digest to the release room.',
      next_fire_at: inMinutes(4),
    }),
    cronTask({
      id: 'cron_fixture_docs',
      cron: '0 18 * * 1-5',
      human_schedule: 'Every weekday at 18:00',
      prompt_preview: 'Sweep the docs for links broken by the sidebar rename.',
      next_fire_at: inMinutes(320),
    }),
    cronTask({
      id: 'cron_fixture_review',
      cron: '0 10 * * 2',
      human_schedule: 'Every Tuesday at 10:00',
      prompt_preview: 'List the pull requests that still block the desktop release.',
      next_fire_at: null,
      paused: true,
      recurring: false,
      age_days: 1,
      created_at: minutesAgo(1_440),
      last_fired_at: minutesAgo(10_000),
    }),
    cronTask({
      id: 'cron_fixture_prune',
      cron: '30 8 * * 1',
      human_schedule: 'Every Monday at 08:30',
      prompt_preview: 'Prune finished worktrees and report the disk space freed.',
      next_fire_at: null,
      paused: true,
      age_days: 12,
      stale: true,
      created_at: minutesAgo(20_160),
      last_fired_at: minutesAgo(10_080),
    }),
    cronTask({
      id: 'cron_fixture_other_hourly',
      session_id: OTHER,
      cron: '0 * * * *',
      human_schedule: 'Every hour',
      prompt_preview: 'Reindex the market data cache and report stale symbols.',
      next_fire_at: inMinutes(38),
      age_days: 5,
    }),
    cronTask({
      id: 'cron_fixture_workspace',
      session_id: null,
      cron: '0 3 * * *',
      human_schedule: 'Every day at 03:00',
      prompt_preview: 'Rotate the workspace scratch directory.',
      next_fire_at: inMinutes(900),
      age_days: 40,
      stale: true,
    }),
  ],
};
