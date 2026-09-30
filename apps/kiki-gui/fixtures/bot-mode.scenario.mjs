/**
 * bot-mode — Bot mode and rooms. Three Bots (林岚 发布协调, 阿澈 写作,
 * 小蓝 调研), 林岚's home session in `delivery: message` with delivered
 * speech, internal prose, reads, a turn that sent nothing, and a handoff to
 * 阿澈; 阿澈's home shows the same handoff arriving. One three-member room is
 * paused on its budget, one is live with a member working and a question
 * queued. On prompt, 林岚 streams a SendMessage draft through
 * `tool.call.delta`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assistantMsg, sessionRecord, toolResultMsg, ts, userMsg, workChanged } from './helpers.mjs';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), 'persona-media');
const WS = 'wd_fixture_000000000000';
const LIN = 'session_bot_lin_lan';
const CHE = 'session_bot_a_che';
const LAN = 'session_bot_xiao_lan';
const ROOM = 'release-031';
const LIVE = 'docs-review';

const face = (id, name, avatar = false) => ({ id, name, ...(avatar ? { avatarUrl: `/api/personas/${id}/avatar` } : {}) });

const personas = [
  { definition: {
    id: 'lin-lan', name: '林岚', title: '发布协调', job: '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
    modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high', delivery: 'message',
    description: '你是林岚，负责 Kiki 的发布协调。说话简短，先给结论；发布动作一律先给清单等确认。',
  }, avatar: { file: join(MEDIA, 'lin-lan.png'), mimeType: 'image/png' } },
  { definition: { id: 'a-che', name: '阿澈', title: '写作', job: '起草 changelog 和发布公告。', description: '你是阿澈，负责写作。一次只改一处，并说明为什么。' }, avatar: { file: join(MEDIA, 'a-che.png'), mimeType: 'image/png', shape: 'circle' } },
  { definition: { id: 'xiao-lan', name: '小蓝', title: '调研', job: '查资料、核对事实。', description: '你是小蓝，负责调研。给出处，不猜。' } },
  { definition: { id: 'lao-zhou', name: '老周', title: '审校', job: '最后一道校对。', description: '你是老周，负责审校。' } },
];

function sendCall(id, text, extra = {}) {
  return { toolUse: { id, name: 'SendMessage', input: { text, ...extra } } };
}

function sendResult(sid, id, minutesAgo, { deliveredTo = ['user'], handoff, sender = { persona_id: 'lin-lan', name: '林岚', session_id: LIN } } = {}) {
  return toolResultMsg(sid, id, JSON.stringify({
    message_id: `msg_${id}`, delivered_to: deliveredTo, sender, attachments: [],
    ...(handoff !== undefined ? { handoff } : {}),
  }), minutesAgo);
}

const HANDOFF = { target_persona_id: 'a-che', target_session_id: CHE, target_name: '阿澈', message_id: 'handoff_1' };

const linMessages = [
  userMsg(LIN, '这周能发 0.31 吗？', 90),
  assistantMsg(LIN, ['先确认阻塞项，再回复。', { toolUse: { id: 'read_1', name: 'Read', input: { path: 'C:/fixture/workshop/RELEASE.md' } } }], 89),
  toolResultMsg(LIN, 'read_1', '# 0.31 checklist\n- [ ] sign cert\n- [ ] changelog', 89),
  assistantMsg(LIN, [{ toolUse: { id: 'read_2', name: 'Read', input: { path: 'C:/fixture/workshop/CHANGELOG.md' } } }], 89),
  toolResultMsg(LIN, 'read_2', '## 0.31\n- #812', 89),
  assistantMsg(LIN, [{ toolUse: { id: 'bash_1', name: 'Bash', input: { command: 'git log --oneline v0.30..HEAD | wc -l' } } }], 88),
  toolResultMsg(LIN, 'bash_1', '47', 88),
  assistantMsg(LIN, [sendCall('send_1', '能，差两件事：\n\n1. 桌面端签名证书还没续期，我让小蓝查续期要多久。\n2. changelog 还缺 3 条（#812 #815 #820）。\n\n其余 47 个提交都已合入。')], 87),
  sendResult(LIN, 'send_1', 87),
  assistantMsg(LIN, [sendCall('send_2', 'changelog 还缺 #812 #815 #820 三条，你来起草，今天下班前给我。', { to: '@阿澈' })], 86),
  sendResult(LIN, 'send_2', 86, { deliveredTo: ['a-che'], handoff: HANDOFF }),
  userMsg(LIN, '证书那边有消息了吗？', 40),
  assistantMsg(LIN, ['小蓝还没回，我先不打扰用户，等她回了再说。'], 39),
  userMsg(LIN, '好，那先把发布清单列出来。', 12),
  assistantMsg(LIN, [{ thinking: '清单按阻塞 → 待办 → 已完成排。' }, { toolUse: { id: 'read_3', name: 'Read', input: { path: 'C:/fixture/workshop/RELEASE.md' } } }], 11),
  toolResultMsg(LIN, 'read_3', '# 0.31 checklist', 11),
  assistantMsg(LIN, [sendCall('send_3', '发布清单（0.31）：\n\n- **阻塞**：签名证书续期（小蓝在查）\n- **待办**：changelog 三条（阿澈起草中）、发布公告\n- **已完成**：47 个提交合入、回归测试通过\n\n确认后我开始准备 tag 草稿，不会直接推送。')], 10),
  sendResult(LIN, 'send_3', 10),
];

const cheMessages = [
  { ...userMsg(CHE, '来自 林岚：changelog 还缺 #812 #815 #820 三条，你来起草，今天下班前给我。', 86), metadata: { origin: { kind: 'peer_thread', source: { hostId: 'local', workspaceId: WS, sessionId: LIN, personaId: 'lin-lan', name: '林岚' }, messageId: 'handoff_1' } } },
  assistantMsg(CHE, [{ toolUse: { id: 'che_read', name: 'Read', input: { path: 'C:/fixture/workshop/CHANGELOG.md' } } }], 85),
  toolResultMsg(CHE, 'che_read', '## 0.31', 85),
  assistantMsg(CHE, [sendCall('che_send', '收到，三条都起草好了，放在 CHANGELOG.md 的 0.31 段里。', { to: '@林岚' })], 80),
  sendResult(CHE, 'che_send', 80, {
    deliveredTo: ['lin-lan'], sender: { persona_id: 'a-che', name: '阿澈', session_id: CHE },
    handoff: { target_persona_id: 'lin-lan', target_session_id: LIN, target_name: '林岚', message_id: 'handoff_2' },
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

const LIN_FACE = face('lin-lan', '林岚', true);
const CHE_FACE = face('a-che', '阿澈');
const LAN_FACE = face('xiao-lan', '小蓝');

const roomDoc = (id, name, extra) => ({
  version: 1, id, name, host: 'lin-lan', mode: 'mention',
  members: [
    { personaId: 'lin-lan', sessionId: `session_room_${id}_lin-lan`, muted: false },
    { personaId: 'a-che', sessionId: `session_room_${id}_a-che`, muted: false },
    { personaId: 'xiao-lan', sessionId: `session_room_${id}_xiao-lan`, muted: id === LIVE },
  ],
  budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/workshop', createdAt: ts(300),
  generation: 0, paused: false, budgetUsed: 0, userMessageCount: 1, cursors: {},
  ...extra,
});

const msg = (id, minutesAgo, from, text, extra = {}) => ({ id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [], ...extra });
const sys = (id, minutesAgo, event, text, data) => ({ id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data ? { data } : {}) });

const roomLog = [
  msg('r1', 60, 'user', '这周能发 0.31 吗？@林岚', { mentions: ['lin-lan'] }),
  msg('r2', 59, 'lin-lan', '能，差两件事。@阿澈 changelog 还缺几条？@小蓝 查一下签名证书续期要多久。', { mentions: ['a-che', 'xiao-lan'] }),
  msg('r3', 57, 'a-che', '缺 3 条：#812 #815 #820。我先起草，10 分钟。'),
  msg('r4', 56, 'a-che', '起草完放在 CHANGELOG.md，@林岚 你过一眼。', { mentions: ['lin-lan'] }),
  msg('r5', 54, 'xiao-lan', '证书续期要 1–2 个工作日，供应商今天下午能受理。', { replyTo: 'r2' }),
  msg('r6', 52, 'lin-lan', '那就按周五发来排：周三前续期，周四冻结，周五上午打 tag。'),
  sys('r7', 50, 'budget_exhausted', 'Discussion paused after 12 bot messages.', { budget: 12 }),
];

const liveLog = [
  msg('d1', 8, 'user', '@所有人 文档站的新首页，大家各看一眼，说说最大的问题。'),
  msg('d2', 7, 'lin-lan', '我先说：首屏没有「下载」按钮，发布周会被问爆。@阿澈 文案你看下。', { mentions: ['a-che'] }),
];

const tokens = (count) => ({ total: { inputOther: count, output: Math.round(count / 6), inputCacheRead: count * 2, inputCacheCreation: 0 } });

export default {
  workspaces: [{ id: WS, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 3, pinned: true }],
  personas,
  bots: [
    { personaId: 'lin-lan', homeSessionId: LIN, pinned: true },
    { personaId: 'a-che', homeSessionId: CHE },
    { personaId: 'xiao-lan', homeSessionId: LAN },
  ],
  sessions: [
    bot(LIN, LIN_FACE, '林岚'),
    bot(CHE, CHE_FACE, '阿澈'),
    bot(LAN, LAN_FACE, '小蓝', { pending_interaction: 'question' }),
    member(ROOM, 'lin-lan', LIN_FACE), member(ROOM, 'a-che', CHE_FACE), member(ROOM, 'xiao-lan', LAN_FACE),
    member(LIVE, 'lin-lan', LIN_FACE), member(LIVE, 'a-che', CHE_FACE, { busy: true }), member(LIVE, 'xiao-lan', LAN_FACE),
    sessionRecord('session_plain_1', { title: '整理 0.30 的回归问题', workspace_id: WS }),
  ],
  snapshots: {
    [LIN]: { messages: linMessages },
    [CHE]: { messages: cheMessages },
    [LAN]: { messages: [] },
    [`session_room_${LIVE}_xiao-lan`]: {
      messages: [],
      pending_questions: [{
        question_id: 'q_room_1', session_id: `session_room_${LIVE}_xiao-lan`, turn_id: 1, created_at: ts(3),
        questions: [{
          id: 'q_room_1_a', question: '首页的对比表要保留旧版本的数据吗？', header: '对比表',
          options: [{ id: 'keep', label: '保留，标注「旧版」' }, { id: 'drop', label: '只放 0.31' }],
        }],
      }],
    },
  },
  rooms: [
    { room: roomDoc(ROOM, '0.31 发布', { paused: true, pauseReason: 'budget', budgetUsed: 12 }), log: roomLog,
      usage: { members: { 'lin-lan': tokens(14_000), 'a-che': tokens(9_000), 'xiao-lan': tokens(5_000) } } },
    { room: roomDoc(LIVE, '文档站改版', { userMessageCount: 1, budgetUsed: 1 }), log: liveLog,
      usage: { members: { 'lin-lan': tokens(3_000) }, questions: { activeSessionId: `session_room_${LIVE}_xiao-lan`, queued: 1 } } },
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
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: 'stream_send', name: 'SendMessage', output: JSON.stringify({ message_id: 'msg_stream', delivered_to: ['user'], sender: { persona_id: 'lin-lan', name: '林岚', session_id: sessionId }, attachments: [] }) } } },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 5200 } } },
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
