/**
 * cron-manage — the scheduled-tasks page as the management surface it is:
 * schedules that read in the reader's language, a create entry that binds a
 * conversation, an editor that never rewrites a complex rule, and a detail
 * panel holding the full prompt and the expression behind the schedule.
 *
 * It carries, on purpose, the cases that used to read badly: a task whose
 * rule has no plain name (`5,25 9,17 * * *`), a one-shot, a paused plan, a
 * workspace-level task with no conversation, and a long prompt whose list row
 * is only a summary. The writes are real against this fixture: create,
 * rebind, edit and delete all mutate the seeded rows.
 */

import { assistantMsg, fid, sessionRecord, userMsg } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const WS_B = 'wd_fixture_000000000001';
const MORNING = 'session_fixture_cron_morning';
const REVIEW = 'session_fixture_cron_review';
const OTHER = 'session_fixture_cron_other';
const ELSEWHERE = 'session_fixture_cron_elsewhere';

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const LONG_PROMPT = [
  'Kiki 走控每小时轻量自检（用户明确要求）：只检查自上次复查以来新增的设计、验证要求，',
  '门禁，结合 analyses/kiki-queue.md 及已有 owner 回执，判断是否真正闭环；',
  '对未闭环项给出下一步动作与责任人，对已闭环项只回一行结论，不重复贴日志；',
  '若本轮没有新增项，直接说明“本轮无新增”，不要为了凑数复述上一轮的检查清单。',
].join('');

function cronTask(overrides) {
  return {
    session_id: MORNING,
    workspace_id: WS,
    cron: '0 9 * * *',
    human_schedule: 'at 09:00 every day',
    prompt: 'Summarize the overnight logs and post the digest to the release room.',
    prompt_preview: 'Summarize the overnight logs and post the digest to the release room.',
    next_fire_at: inMinutes(32),
    recurring: true,
    delivery_mode: 'idle',
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
    sessionRecord(MORNING, { title: 'Kiki 改版主控（接手）', message_count: 4, last_seq: 4 }),
    sessionRecord(REVIEW, { title: 'PR 评审队列', message_count: 2, last_seq: 2, updated_at: minutesAgo(26) }),
    sessionRecord(OTHER, { title: '行情缓存维护', message_count: 1, last_seq: 1, updated_at: minutesAgo(90) }),
    sessionRecord(ELSEWHERE, {
      title: '另一个工作区的对话',
      workspace_id: WS_B,
      message_count: 1,
      last_seq: 1,
      updated_at: minutesAgo(140),
    }),
  ],
  snapshots: {
    [MORNING]: {
      messages: [
        userMsg(MORNING, '把走控挂成定时任务，每小时整点自己查一遍新增的设计与验证要求。', 40),
        assistantMsg(MORNING, ['已经挂上，每小时整点触发一次。'], 38),
      ],
    },
  },
  cronTasks: [
    cronTask({
      id: 'cron_fixture_hourly',
      cron: '0 * * * *',
      human_schedule: 'at minute 0 of every hour',
      prompt: LONG_PROMPT,
      prompt_preview: `${LONG_PROMPT.slice(0, 120)}…(truncated)`,
      next_fire_at: inMinutes(32),
    }),
    cronTask({
      id: 'cron_fixture_daily',
      cron: '0 9 * * 1-5',
      human_schedule: 'at 09:00 on Monday, Tuesday, Wednesday, Thursday, Friday',
      prompt: 'Check whether the nightly self-check found anything the owner has not answered yet.',
      prompt_preview: 'Check whether the nightly self-check found anything the owner has not answered yet.',
      session_id: REVIEW,
      next_fire_at: inMinutes(320),
      delivery_mode: 'queue',
    }),
    cronTask({
      id: 'cron_fixture_weekly',
      cron: '30 8 * * 1',
      human_schedule: 'at 08:30 on Monday',
      prompt: 'Prune finished worktrees and report the disk space freed.',
      prompt_preview: 'Prune finished worktrees and report the disk space freed.',
      session_id: OTHER,
      next_fire_at: inMinutes(1_180),
    }),
    cronTask({
      // A rule with no plain name. It must keep its exact text through an
      // open-and-save, which is the whole point of the advanced editor.
      id: 'cron_fixture_complex',
      cron: '5,25 9,17 * * *',
      human_schedule: '5,25 9,17 * * *',
      prompt: 'Spot-check the two release windows against the staging queue.',
      prompt_preview: 'Spot-check the two release windows against the staging queue.',
      next_fire_at: inMinutes(95),
      age_days: 61,
      stale: true,
      delivery_mode: 'steer',
    }),
    cronTask({
      // A minute frequency: fire-able several times an hour, which the
      // friendly controls cannot represent. Saving it must not become
      // "once an hour".
      id: 'cron_fixture_frequency',
      cron: '*/30 * * * *',
      human_schedule: 'every 30 minutes',
      prompt: 'Poll the release queue for anything that moved since the last check.',
      prompt_preview: 'Poll the release queue for anything that moved since the last check.',
      next_fire_at: inMinutes(12),
    }),
    cronTask({
      id: 'cron_fixture_paused',
      cron: '0 10 * * 2',
      human_schedule: 'at 10:00 on Tuesday',
      prompt: 'List the pull requests that still block the desktop release.',
      prompt_preview: 'List the pull requests that still block the desktop release.',
      paused: true,
      next_fire_at: null,
      last_fired_at: minutesAgo(10_000),
    }),
    cronTask({
      // Workspace-level: no conversation owns it, so it must read as such
      // rather than as a broken link.
      id: 'cron_fixture_workspace',
      session_id: null,
      cron: '0 3 * * *',
      human_schedule: 'at 03:00 every day',
      prompt: 'Rotate the workspace scratch directory.',
      prompt_preview: 'Rotate the workspace scratch directory.',
      next_fire_at: inMinutes(900),
      age_days: 40,
      stale: true,
      // `undefined` on purpose: a task from before delivery modes existed.
      // The list must show it as the default rather than inventing one.
      delivery_mode: undefined,
    }),
  ],
  workspaces: [
    { id: WS, name: 'EasyAgent', root: 'C:/fixture/easyagent', pinned: true },
    { id: WS_B, name: 'Pipi', root: 'C:/fixture/pipi', pinned: false },
  ],
};

export { LONG_PROMPT, MORNING, REVIEW, OTHER, ELSEWHERE, WS, WS_B, fid };
