/**
 * room-timeline — the room branch of a session timeline, a room the composer
 * link recognises, and the CJK autolink that used to render as a grey
 * "Blocked URL" chip. Uses the real ThreadSend room args and receipt shape
 * (`{room, content, mentions?}` → `{roomId, messageId, delivery}`) and a
 * system-only room catch-up, so the surfaces are shown the wires they get.
 */

import { assistantMsg, sessionRecord, toolResultMsg, ts, userMsg } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const CURRENT = 'session_fixture_rt_current';
const ROOM_ID = 'release-contract';
const ROOM_NAME = 'Release contract';

const roomSend = (id, args, receipt) => [
  assistantMsg(CURRENT, [{ toolUse: { id, name: 'ThreadSend', input: args } }], 6),
  toolResultMsg(CURRENT, id, JSON.stringify(receipt, null, 2), 6),
];

const CURRENT_MESSAGES = [
  userMsg(CURRENT, 'Run the release checklist for the contract room.', 8),
  // A real room send: the tool card must read as a room, not a peer thread.
  ...roomSend('call_room_ok', { room: ROOM_ID, content: 'Please summarise what the blocking review found.', mentions: ['session_fixture_peer'] },
    { roomId: ROOM_ID, messageId: 'msg_room_1', delivery: 'delivered' }),
  assistantMsg(CURRENT, ['Posted. I will report back when the review answers.'], 6),
  // A room send that the room refused.
  ...roomSend('call_room_bad', { room: ROOM_ID, content: 'status?' },
    { roomId: ROOM_ID, delivery: 'undeliverable' }),
  // The reported regression: a bold preview URL beside CJK punctuation.
  assistantMsg(CURRENT, ['新版预览已启动：**http://127.0.0.1:63474**，浏览器也已打开。'], 3),
  // A room the composer link recognises, next to an ordinary thread link.
  userMsg(CURRENT, `对齐一下 /rooms/${ROOM_ID} 与 /s/session_fixture_peer 的结论。`, 2),
];

export default {
  workspaces: [
    { id: WS, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(600), last_opened_at: ts(1), session_count: 3, pinned: false },
  ],
  sessions: [
    sessionRecord(CURRENT, { title: 'Release coordination', workspace_id: WS, updated_at: ts(1) }),
    sessionRecord('session_fixture_peer', { title: 'Review findings', workspace_id: WS, updated_at: ts(4) }),
  ],
  snapshots: {
    [CURRENT]: { messages: CURRENT_MESSAGES, has_more: false },
  },
  rooms: [
    { room: {
      version: 1, id: ROOM_ID, name: ROOM_NAME, host: 'session_fixture_peer', mode: 'mention',
      members: [
        { sessionId: 'session_fixture_peer', kind: 'thread', joinedAt: ts(90) },
        { sessionId: CURRENT, kind: 'thread', joinedAt: ts(90) },
      ],
      budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/workshop', createdAt: ts(90),
      generation: 0, paused: false, budgetUsed: 1, userMessageCount: 1, cursors: {},
    }, log: [
      { id: 'm_1', at: ts(10), kind: 'message', from: 'user', username: 'User', text: '对一下发布顺序。' },
      { id: 'm_2', at: ts(5), kind: 'message', from: 'session_fixture_peer', text: '先合并契约，再发版。' },
    ] },
  ],
};
