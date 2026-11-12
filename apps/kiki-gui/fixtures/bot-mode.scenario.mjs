/**
 * bot-mode — Bot mode and rooms. Three Bots (小柚 发布协调, 豆豆 写作,
 * 米粒 调研), 小柚's home session in `delivery: message` with delivered
 * speech, internal prose, reads, a turn that sent nothing, and a handoff to
 * 豆豆; 豆豆's home shows the same handoff arriving. One three-member room is
 * paused on its budget, one is live with a member working and a question
 * queued. On prompt, 小柚 streams a SendMessage draft through
 * `tool.call.delta`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assistantMsg, sessionRecord, toolResultMsg, ts, userMsg, workChanged } from './helpers.mjs';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), 'persona-media');
const WS = 'wd_fixture_000000000000';
const LIN = 'session_bot_xiao_you';
const CHE = 'session_bot_dou_dou';
const LAN = 'session_bot_mi_li';
const ROOM = 'release-031';
const LIVE = 'docs-review';

const face = (id, name, avatar = false) => ({ id, name, ...(avatar ? { avatarUrl: `/api/personas/${id}/avatar` } : {}) });

const personas = [
  { definition: {
    id: 'xiao-you', name: '小柚', title: '发布协调', job: '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
    modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high', delivery: 'message',
    description: '你是小柚，负责 Kiki 的发布协调。说话简短，先给结论；发布动作一律先给清单等确认。',
  }, avatar: { file: join(MEDIA, 'xiao-you.png'), mimeType: 'image/png' } },
  { definition: { id: 'dou-dou', name: '豆豆', title: '写作', job: '起草 changelog 和发布公告。', description: '你是豆豆，负责写作。一次只改一处，并说明为什么。' }, avatar: { file: join(MEDIA, 'dou-dou.png'), mimeType: 'image/png', shape: 'circle' } },
  { definition: { id: 'mi-li', name: '米粒', title: '调研', job: '查资料、核对事实。', description: '你是米粒，负责调研。给出处，不猜。' } },
  { definition: { id: 'lao-zhou', name: '老周', title: '审校', job: '最后一道校对。', description: '你是老周，负责审校。' } },
];

function sendCall(id, text, extra = {}) {
  return { toolUse: { id, name: 'SendMessage', input: { text, ...extra } } };
}

function sendResult(sid, id, minutesAgo, { deliveredTo = ['user'], handoff, sender = { persona_id: 'xiao-you', name: '小柚', session_id: LIN } } = {}) {
  return toolResultMsg(sid, id, JSON.stringify({
    message_id: `msg_${id}`, delivered_to: deliveredTo, sender, attachments: [],
    ...(handoff !== undefined ? { handoff } : {}),
  }), minutesAgo);
}

const HANDOFF = { target_persona_id: 'dou-dou', target_session_id: CHE, target_name: '豆豆', message_id: 'handoff_1' };

const linMessages = [
  userMsg(LIN, '这周能发 0.31 吗？', 90),
  assistantMsg(LIN, ['先确认阻塞项，再回复。', { toolUse: { id: 'read_1', name: 'Read', input: { path: 'C:/fixture/workshop/RELEASE.md' } } }], 89),
  toolResultMsg(LIN, 'read_1', '# 0.31 checklist\n- [ ] sign cert\n- [ ] changelog', 89),
  assistantMsg(LIN, [{ toolUse: { id: 'read_2', name: 'Read', input: { path: 'C:/fixture/workshop/CHANGELOG.md' } } }], 89),
  toolResultMsg(LIN, 'read_2', '## 0.31\n- #812', 89),
  assistantMsg(LIN, [{ toolUse: { id: 'bash_1', name: 'Bash', input: { command: 'git log --oneline v0.30..HEAD | wc -l' } } }], 88),
  toolResultMsg(LIN, 'bash_1', '47', 88),
  assistantMsg(LIN, [sendCall('send_1', '能，差两件事：\n\n1. 桌面端签名证书还没续期，我让米粒查续期要多久。\n2. changelog 还缺 3 条（#812 #815 #820）。\n\n其余 47 个提交都已合入。')], 87),
  sendResult(LIN, 'send_1', 87),
  assistantMsg(LIN, [sendCall('send_2', 'changelog 还缺 #812 #815 #820 三条，你来起草，今天下班前给我。', { to: '@豆豆' })], 86),
  sendResult(LIN, 'send_2', 86, { deliveredTo: ['dou-dou'], handoff: HANDOFF }),
  userMsg(LIN, '证书那边有消息了吗？', 40),
  assistantMsg(LIN, ['米粒还没回，我先不打扰用户，等她回了再说。'], 39),
  userMsg(LIN, '好，那先把发布清单列出来。', 12),
  assistantMsg(LIN, [{ thinking: '清单按阻塞 → 待办 → 已完成排。' }, { toolUse: { id: 'read_3', name: 'Read', input: { path: 'C:/fixture/workshop/RELEASE.md' } } }], 11),
  toolResultMsg(LIN, 'read_3', '# 0.31 checklist', 11),
  assistantMsg(LIN, [sendCall('send_3', '发布清单（0.31）：\n\n- **阻塞**：签名证书续期（米粒在查）\n- **待办**：changelog 三条（豆豆起草中）、发布公告\n- **已完成**：47 个提交合入、回归测试通过\n\n确认后我开始准备 tag 草稿，不会直接推送。')], 10),
  sendResult(LIN, 'send_3', 10),
];

const cheMessages = [
  { ...userMsg(CHE, '来自 小柚：changelog 还缺 #812 #815 #820 三条，你来起草，今天下班前给我。', 86), metadata: { origin: { kind: 'peer_thread', source: { hostId: 'local', workspaceId: WS, sessionId: LIN, personaId: 'xiao-you', name: '小柚' }, messageId: 'handoff_1' } } },
  assistantMsg(CHE, [{ toolUse: { id: 'che_read', name: 'Read', input: { path: 'C:/fixture/workshop/CHANGELOG.md' } } }], 85),
  toolResultMsg(CHE, 'che_read', '## 0.31', 85),
  assistantMsg(CHE, [sendCall('che_send', '收到，三条都起草好了，放在 CHANGELOG.md 的 0.31 段里。', { to: '@小柚' })], 80),
  sendResult(CHE, 'che_send', 80, {
    deliveredTo: ['xiao-you'], sender: { persona_id: 'dou-dou', name: '豆豆', session_id: CHE },
    handoff: { target_persona_id: 'xiao-you', target_session_id: LIN, target_name: '小柚', message_id: 'handoff_2' },
  }),
];

const bot = (id, persona, title, extra = {}) => sessionRecord(id, {
  title, workspace_id: WS, delivery: 'message',
  metadata: { cwd: `C:/fixture/bots/${persona.id}`, bot_persona_id: persona.id },
  agent_config: { model: 'fixture/kiki-pro', persona },
  ...extra,
});

const member = (roomId, personaId, persona, extra = {}) => sessionRecord(`session_room_${roomId}_${personaId}`, {
  title: `${roomId} · ${persona.name}`, workspace_id: WS, delivery: 'message',
  metadata: { cwd: 'C:/fixture/workshop', room_member_of: roomId, room_persona_id: personaId },
  agent_config: { model: 'fixture/kiki-pro', persona },
  ...extra,
});

const LIN_FACE = face('xiao-you', '小柚', true);
const CHE_FACE = face('dou-dou', '豆豆');
const LAN_FACE = face('mi-li', '米粒');

const roomDoc = (id, name, extra) => ({
  version: 1, id, name, host: 'xiao-you', mode: 'mention',
  members: [
    { personaId: 'xiao-you', sessionId: `session_room_${id}_xiao-you`, muted: false },
    { personaId: 'dou-dou', sessionId: `session_room_${id}_dou-dou`, muted: false },
    { personaId: 'mi-li', sessionId: `session_room_${id}_mi-li`, muted: id === LIVE },
  ],
  budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/workshop', createdAt: ts(300),
  generation: 0, paused: false, budgetUsed: 0, userMessageCount: 1, cursors: {},
  ...extra,
});

const msg = (id, minutesAgo, from, text, extra = {}) => ({ id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [], ...extra });
const sys = (id, minutesAgo, event, text, data) => ({ id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data ? { data } : {}) });

const roomLog = [
  msg('r1', 60, 'user', '这周能发 0.31 吗？@小柚', { mentions: ['xiao-you'] }),
  msg('r2', 59, 'xiao-you', '能，差两件事。@豆豆 changelog 还缺几条？@米粒 查一下签名证书续期要多久。', { mentions: ['dou-dou', 'mi-li'] }),
  msg('r3', 57, 'dou-dou', '缺 3 条：#812 #815 #820。我先起草，10 分钟。'),
  msg('r4', 56, 'dou-dou', '起草完放在 CHANGELOG.md，@小柚 你过一眼。', { mentions: ['xiao-you'] }),
  msg('r5', 54, 'mi-li', '证书续期要 1–2 个工作日，供应商今天下午能受理。', { replyTo: 'r2' }),
  msg('r6', 52, 'xiao-you', '那就按周五发来排：周三前续期，周四冻结，周五上午打 tag。'),
  sys('r7', 50, 'budget_exhausted', 'Discussion paused after 12 bot messages.', { budget: 12 }),
];

const liveLog = [
  msg('d1', 8, 'user', '@所有人 文档站的新首页，大家各看一眼，说说最大的问题。'),
  msg('d2', 7, 'xiao-you', '我先说：首屏没有「下载」按钮，发布周会被问爆。@豆豆 文案你看下。', { mentions: ['dou-dou'] }),
];

const tokens = (count) => ({ total: { inputOther: count, output: Math.round(count / 6), inputCacheRead: count * 2, inputCacheCreation: 0 } });

export default {
  workspaces: [{ id: WS, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 3, pinned: true }],
  personas,
  bots: [
    { personaId: 'xiao-you', homeSessionId: LIN, pinned: true },
    { personaId: 'dou-dou', homeSessionId: CHE },
    { personaId: 'mi-li', homeSessionId: LAN },
  ],
  sessions: [
    bot(LIN, LIN_FACE, '小柚'),
    bot(CHE, CHE_FACE, '豆豆'),
    bot(LAN, LAN_FACE, '米粒', { pending_interaction: 'question' }),
    member(ROOM, 'xiao-you', LIN_FACE), member(ROOM, 'dou-dou', CHE_FACE), member(ROOM, 'mi-li', LAN_FACE),
    member(LIVE, 'xiao-you', LIN_FACE), member(LIVE, 'dou-dou', CHE_FACE, { busy: true }), member(LIVE, 'mi-li', LAN_FACE),
    sessionRecord('session_plain_1', { title: '整理 0.30 的回归问题', workspace_id: WS }),
  ],
  snapshots: {
    [LIN]: { messages: linMessages },
    [CHE]: { messages: cheMessages },
    [LAN]: { messages: [] },
    [`session_room_${LIVE}_mi-li`]: {
      messages: [],
      pending_questions: [{
        question_id: 'q_room_1', session_id: `session_room_${LIVE}_mi-li`, turn_id: 1, created_at: ts(3),
        questions: [{
          id: 'q_room_1_a', question: '首页的对比表要保留旧版本的数据吗？', header: '对比表',
          options: [{ id: 'keep', label: '保留，标注「旧版」' }, { id: 'drop', label: '只放 0.31' }],
        }],
      }],
    },
  },
  rooms: [
    { room: roomDoc(ROOM, '0.31 发布', { paused: true, pauseReason: 'budget', budgetUsed: 12 }), log: roomLog,
      usage: { members: { 'xiao-you': tokens(14_000), 'dou-dou': tokens(9_000), 'mi-li': tokens(5_000) } } },
    { room: roomDoc(LIVE, '文档站改版', { userMessageCount: 1, budgetUsed: 1 }), log: liveLog,
      usage: { members: { 'xiao-you': tokens(3_000) }, questions: { activeSessionId: `session_room_${LIVE}_mi-li`, queued: 1 } } },
  ],
  roomRunning: { [LIVE]: true },
  memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} },
  onPrompt: (text, sessionId) => [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: text } } },
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    { delay: 300 },
    { frame: { type: 'tool.call.started', payload: { turnId: 1, toolCallId: 'stream_send', name: 'SendMessage', args: '' } } },
    ...['{"text":"', '收到。', '我先', '核对一下', '证书续期', '的进度，', '十分钟内', '回你。"}'].map((part, index) => ({
      delay: index === 0 ? 100 : 700,
      frame: { type: 'tool.call.delta', payload: { turnId: 1, toolCallId: 'stream_send', name: 'SendMessage', argumentsPart: part } },
    })),
    { waitFor: 'release' },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: 'stream_send', name: 'SendMessage', output: JSON.stringify({ message_id: 'msg_stream', delivered_to: ['user'], sender: { persona_id: 'xiao-you', name: '小柚', session_id: sessionId }, attachments: [] }) } } },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 5200 } } },
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
