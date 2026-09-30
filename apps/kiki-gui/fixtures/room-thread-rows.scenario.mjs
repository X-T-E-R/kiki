/**
 * room-thread-rows — the sidebar's merged conversation list. Four rooms in
 * two workspaces sit among plain threads: 接口契约 busy with fresh log lines,
 * 发布协调 waiting on a member's approval, 夜间巡检 paused on budget, and
 * 设计走查 pinned. Threads spread across today / yesterday / older so the
 * time buckets read; every seeded row is unread (no seen marks on a fresh
 * client).
 */

import { sessionRecord, ts } from './helpers.mjs';

const WS_A = 'wd_fixture_000000000000';
const WS_B = 'wd_fixture_web_0000000';
const BACKEND = 'session_row_backend';
const REVIEW = 'session_row_review';

const thread = (id, title, workspace, cwd, extra = {}) => sessionRecord(id, {
  title, workspace_id: workspace, metadata: { cwd }, agent_config: { model: 'fixture/kiki-pro' }, ...extra,
});

const member = (sessionId, minutesAgo) => ({ kind: 'thread', sessionId, muted: false, joinedAt: ts(minutesAgo), queueWhenBusy: true });
const msg = (id, minutesAgo, from, text) => ({ id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [] });
const sys = (id, minutesAgo, event, text, data) => ({ id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data ? { data } : {}) });

export default {
  workspaces: [
    { id: WS_A, root: 'C:/fixture/api', name: 'api', created_at: ts(4_000), last_opened_at: ts(4), session_count: 3, pinned: true },
    { id: WS_B, root: 'C:/fixture/web', name: 'web', created_at: ts(4_000), last_opened_at: ts(6), session_count: 2, pinned: false },
  ],
  config: {
    default_model: 'fixture/kiki-pro', default_permission_mode: 'manual', providers: {},
    thread_communication: { enabled: true },
  },
  personas: [],
  bots: [],
  sessions: [
    thread(BACKEND, '迁移游标分页', WS_A, 'C:/fixture/api', { busy: true, updated_at: ts(2) }),
    thread(REVIEW, '发布检查单', WS_B, 'C:/fixture/web', { pending_interaction: 'approval', updated_at: ts(8), last_seq: 2 }),
    thread('session_row_tests', '翻页用例补齐', WS_A, 'C:/fixture/api', { updated_at: ts(60) }),
    thread('session_row_copy', '落地页文案', WS_B, 'C:/fixture/web', { updated_at: ts(300), last_seq: 4 }),
    thread('session_row_errors', '错误码梳理', WS_A, 'C:/fixture/api', { updated_at: ts(1_500) }),
    thread('session_row_old', '旧版迁移脚本', WS_A, 'C:/fixture/api', { updated_at: ts(60 * 24 * 9) }),
    thread('session_row_design', '界面走查笔记', WS_A, 'C:/fixture/api', { updated_at: ts(60 * 24 * 12) }),
  ],
  rooms: [
    { room: {
      version: 1, id: 'contract-room', name: '接口契约', host: BACKEND, mode: 'mention',
      members: [member(BACKEND, 90), member('session_row_tests', 90)],
      budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/api', createdAt: ts(90),
      generation: 0, paused: false, budgetUsed: 2, userMessageCount: 1, cursors: {},
    }, log: [
      sys('j1', 90, 'member_joined', `${BACKEND} joined the room.`, { memberId: BACKEND, kind: 'thread' }),
      sys('j2', 90, 'member_joined', `session_row_tests joined the room.`, { memberId: 'session_row_tests', kind: 'thread' }),
      msg('u1', 12, 'user', '对一下 /sessions 分页接口：游标字段叫什么？'),
      msg('b1', 5, BACKEND, '响应加 `next_cursor`（不透明字符串），请求带 `cursor` 继续。'),
    ] },
    { room: {
      version: 1, id: 'release-room', name: '发布协调', host: REVIEW, mode: 'mention',
      members: [member(REVIEW, 200)],
      budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/web', createdAt: ts(200),
      generation: 0, paused: false, budgetUsed: 1, userMessageCount: 1, cursors: {},
    }, log: [
      sys('j1', 200, 'member_joined', `${REVIEW} joined the room.`, { memberId: REVIEW, kind: 'thread' }),
      msg('u1', 30, 'user', '0.32 的发布顺序排一下。'),
      msg('r1', 25, REVIEW, '先发 kap，再发 GUI；检查单里有一项要你确认。'),
    ] },
    { room: {
      version: 1, id: 'nightly-room', name: '夜间巡检', host: BACKEND, mode: 'mention',
      members: [member(BACKEND, 2_000)],
      budget: { botMessagesPerUserMessage: 4 }, workspace: 'C:/fixture/api', createdAt: ts(2_000),
      generation: 1, paused: true, pauseReason: 'budget', budgetUsed: 4, userMessageCount: 1, cursors: {},
    }, log: [
      sys('j1', 2_000, 'member_joined', `${BACKEND} joined the room.`, { memberId: BACKEND, kind: 'thread' }),
      msg('u1', 220, 'user', '今晚把三个仓的依赖巡检一遍。'),
      sys('p1', 210, 'paused', 'Discussion paused (4 messages used this turn).', { budget: 4 }),
    ] },
    { room: {
      version: 1, id: 'design-room', name: '设计走查', host: 'session_row_design', mode: 'mention', pinned: true,
      members: [member('session_row_design', 3_000)],
      budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/api', createdAt: ts(3_000),
      generation: 0, paused: false, budgetUsed: 0, userMessageCount: 0, cursors: {},
    }, log: [
      sys('j1', 3_000, 'member_joined', `session_row_design joined the room.`, { memberId: 'session_row_design', kind: 'thread' }),
      msg('u1', 400, 'user', '周五过一遍新侧栏。'),
      msg('r1', 390, 'session_row_design', '好，我先列走查点。'),
    ] },
  ],
};
