/**
 * thread-rooms — existing threads pulled into one room. Three top-level
 * threads in two workspaces (后端线程 busy with "wait while busy" on, 前端线程
 * idle, 测试线程 with the switch off) sit in 「接口契约」, whose log shows
 * joins, a thread speaking through ThreadSend, a leave and a busy notice.
 * A fourth thread (文档线程) and a subagent child are outside the room: the
 * first can be added from the members rail; the child is never offered.
 * The session rail of 后端线程 lists the room deliveries it received.
 *
 * `config.thread_communication.enabled` is on; the proof toggles it off
 * through `POST /config` to show the disabled entries.
 */

import { sessionRecord, ts, userMsg, assistantMsg } from './helpers.mjs';

const WS_A = 'wd_fixture_000000000000';
const WS_B = 'wd_fixture_web_0000000';
const BACKEND = 'session_thread_backend';
const FRONTEND = 'session_thread_frontend';
const TESTS = 'session_thread_tests';
const DOCS = 'session_thread_docs';
const CHILD = 'session_thread_backend_child';
const ROOM = 'api-contract';

const thread = (id, title, workspace, cwd, extra = {}) => sessionRecord(id, {
  title, workspace_id: workspace, metadata: { cwd }, agent_config: { model: 'fixture/kiki-pro' }, ...extra,
});

const member = (sessionId, minutesAgo, queueWhenBusy = true) => ({ kind: 'thread', sessionId, muted: false, joinedAt: ts(minutesAgo), queueWhenBusy });
const msg = (id, minutesAgo, from, text, extra = {}) => ({ id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [], ...extra });
const sys = (id, minutesAgo, event, text, data) => ({ id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data ? { data } : {}) });

const roomLog = [
  sys('j1', 40, 'member_joined', `${BACKEND} joined the room.`, { memberId: BACKEND, kind: 'thread' }),
  sys('j2', 40, 'member_joined', `${FRONTEND} joined the room.`, { memberId: FRONTEND, kind: 'thread' }),
  sys('j3', 40, 'member_joined', `${TESTS} joined the room.`, { memberId: TESTS, kind: 'thread' }),
  sys('j4', 40, 'member_joined', `${DOCS} joined the room.`, { memberId: DOCS, kind: 'thread' }),
  msg('u1', 38, 'user', '对一下 /sessions 分页接口：@前端线程 你们现在按什么字段翻页？', { mentions: [FRONTEND] }),
  msg('f1', 36, FRONTEND, '现在用 `offset/limit`。列表会实时插入新会话，翻页时偶尔重复一条。@后端线程 能给游标吗？', { mentions: [BACKEND] }),
  sys('b1', 36, 'member_busy', `${BACKEND} is busy and will receive this message after its current turn.`, { sessionId: BACKEND, sourceMessageId: 'f1' }),
  msg('b2', 30, BACKEND, '可以。响应加 `next_cursor`（不透明字符串），请求带 `cursor` 继续；`offset` 保留一个版本后移除。\n\n@测试线程 这条改动需要一组翻页时插入新会话的用例。', { mentions: [TESTS] }),
  msg('t1', 28, TESTS, '收到，我补三条：首页、中途插入、游标失效后重来。'),
  sys('l1', 20, 'member_left', `${DOCS} left the room.`, { memberId: DOCS, kind: 'thread' }),
];

const catchup = (rows, id) => `<room-messages room="${ROOM}" since="">${rows.join('\n')}\n</room-messages>\nYou were selected for room message ${id}.`;
const endpoint = (sessionId, title, workspace) => ({ ref: { host_id: 'fixture-host', workspace_id: workspace, session_id: sessionId }, title, deleted: false, archived: false });

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
    thread(BACKEND, '后端线程', WS_A, 'C:/fixture/api', { busy: true, updated_at: ts(1) }),
    thread(FRONTEND, '前端线程', WS_B, 'C:/fixture/web', { updated_at: ts(3) }),
    thread(TESTS, '测试线程', WS_A, 'C:/fixture/api', { updated_at: ts(5) }),
    thread(DOCS, '文档线程', WS_B, 'C:/fixture/web', { updated_at: ts(9) }),
    thread(CHILD, '后端线程 · 迁移脚本', WS_A, 'C:/fixture/api', { metadata: { cwd: 'C:/fixture/api', parent_session_id: BACKEND, child_session_kind: 'child' } }),
    thread('session_thread_release', '整理 0.32 发布清单', WS_A, 'C:/fixture/api', { updated_at: ts(30) }),
  ],
  snapshots: {
    [BACKEND]: { messages: [userMsg(BACKEND, '把 /sessions 的分页迁到游标。', 60), assistantMsg(BACKEND, ['在改 `listSessions`，先跑一遍现有测试。'], 59)] },
    [FRONTEND]: { messages: [userMsg(FRONTEND, '会话列表滚动加载有重复。', 70), assistantMsg(FRONTEND, ['复现了：翻页期间插入新会话会让 offset 错位。'], 69)] },
  },
  rooms: [
    { room: {
      version: 1, id: ROOM, name: '接口契约', host: FRONTEND, mode: 'mention',
      members: [member(BACKEND, 40), member(FRONTEND, 40), member(TESTS, 40, false)],
      budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/api', createdAt: ts(40),
      generation: 0, paused: false, budgetUsed: 2, userMessageCount: 1, cursors: {},
    }, log: roomLog },
  ],
  threadMessages: [
    { message_id: 'rm_2', source: { kind: 'room', room_id: ROOM }, target: endpoint(TESTS, '测试线程', WS_A),
      content: catchup(['[b2 后端线程 (session_thread_backend)] @session_thread_tests 这条改动需要一组翻页时插入新会话的用例。'], 'b2'),
      accepted_at: Date.parse(ts(30)), target_seq: 1, delivery: 'delivered' },
    { message_id: 'rm_1', source: { kind: 'room', room_id: ROOM }, target: endpoint(BACKEND, '后端线程', WS_A),
      content: catchup(['[u1 User] @session_thread_frontend 对一下 /sessions 分页接口', '[f1 前端线程 (session_thread_frontend)] @session_thread_backend 能给游标吗？'], 'f1'),
      accepted_at: Date.parse(ts(36)), target_seq: 1, delivery: 'pending' },
    { message_id: 'pm_1', source: { kind: 'thread', thread: endpoint(FRONTEND, '前端线程', WS_B) }, target: endpoint(BACKEND, '后端线程', WS_A),
      content: '分页接口的 PR 链接发我一下。', accepted_at: Date.parse(ts(50)), target_seq: 2, delivery: 'delivered' },
  ],
};
