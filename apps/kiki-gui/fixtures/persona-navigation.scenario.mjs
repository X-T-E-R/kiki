/**
 * persona-navigation — the 角色 group, the shared conversation switcher, the
 * daily-conversation route and the persona detail's conversation list.
 *
 * Three personas, each covering one shape the navigation must tell apart:
 *   - 林岚 has a daily conversation (a seeded home, a legacy Bot home in the
 *     same shape the running server leaves behind) plus two topics in two
 *     different workspaces and one room seat;
 *   - 阿澈 has no daily conversation yet, so /p/a-che/daily is a draft;
 *   - 小蓝 is pinned with two unread conversations, so the row's badge has more
 *     than one answer and must open the switcher instead of guessing.
 *
 * Seeds `homeSessionId` on the persona summaries (D1) — the GUI's daily route
 * reads the persona directory, not the legacy Bot list.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assistantMsg, sessionRecord, ts, userMsg } from './helpers.mjs';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), 'persona-media');
const WS_APP = 'wd_fixture_000000000000';
const WS_DOCS = 'wd_docs_site_000000000000';

const LIN = 'session_daily_lin_lan';
const LIN_RELEASE = 'session_lin_release';
const LIN_DOCS = 'session_lin_docs';
const ROOM = 'release-031';
const LIN_ROOM = `session_room_${ROOM}_lin-lan`;
const CHE = 'session_daily_a_che';
const LAN_ONE = 'session_lan_notes';
const LAN_TWO = 'session_lan_facts';

const face = (id, name, avatar = false) => ({ id, name, ...(avatar ? { avatarUrl: `/api/personas/${id}/avatar` } : {}) });

const personas = [
  {
    definition: {
      id: 'lin-lan', name: '林岚', title: '发布协调', job: '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
      modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high', delivery: 'message', homeWorkspace: WS_APP,
      greeting: '我在。这周要发哪个版本？',
      description: '你是林岚，负责 Kiki 的发布协调。说话简短，先给结论；发布动作一律先给清单等确认。',
    },
    avatar: { file: join(MEDIA, 'lin-lan.png'), mimeType: 'image/png' },
    homeSessionId: LIN,
  },
  {
    definition: {
      id: 'a-che', name: '阿澈', title: '写作搭子', job: '陪你改稿：先听你想说什么，再动句子。',
      homeWorkspace: WS_DOCS,
      greeting: '这段文字要给谁看？先说这个，我再动句子。',
      description: '你是阿澈。先问清楚这段文字要给谁看、想让对方做什么，再提修改；一次只改一处，并说明为什么。',
    },
    avatar: { file: join(MEDIA, 'a-che.png'), mimeType: 'image/png', shape: 'circle' },
  },
  {
    definition: {
      // Deliberately long: the stress case for a name that has to give way
      // (sidebar row, 390 header identity, hero) without dropping the person.
      id: 'xiao-lan', name: '小蓝 · 事实核查与出处核对', title: '调研', job: '查资料、核对事实，给出处。',
      description: '你是小蓝，负责调研。给出处，不猜。',
    },
    pinned: true,
  },
];

const personaSession = (id, personaId, persona, patch = {}) => sessionRecord(id, {
  workspace_id: WS_APP,
  metadata: { cwd: 'C:/fixture/workshop' },
  agent_config: { model: 'fixture/kiki-pro', persona },
  ...patch,
});

const daily = (id, personaId, persona, patch = {}) => personaSession(id, personaId, persona, {
  delivery: 'message',
  metadata: { cwd: `C:/fixture/bots/${personaId}`, bot_persona_id: personaId },
  ...patch,
});

const LIN_FACE = face('lin-lan', '林岚', true);
const CHE_FACE = face('a-che', '阿澈');
const LAN_FACE = face('xiao-lan', '小蓝 · 事实核查与出处核对');

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 3, pinned: true },
    { id: WS_DOCS, root: 'C:/fixture/docs-site', name: 'docs-site', created_at: ts(9_000), last_opened_at: ts(220), session_count: 1, pinned: false },
  ],
  personas,
  bots: [
    { personaId: 'lin-lan', homeSessionId: LIN, pinned: false },
  ],
  sessions: [
    daily(LIN, 'lin-lan', LIN_FACE, { title: '0.31 能发吗', updated_at: ts(12) }),
    personaSession(LIN_RELEASE, 'lin-lan', LIN_FACE, { title: '0.31 发布清单', workspace_id: WS_APP, updated_at: ts(30) }),
    personaSession(LIN_DOCS, 'lin-lan', LIN_FACE, { title: '文档站首页改版', workspace_id: WS_DOCS, updated_at: ts(1_500) }),
    daily(LIN_ROOM, 'lin-lan', LIN_FACE, {
      title: `${ROOM} · 林岚`, metadata: { cwd: 'C:/fixture/workshop', room_member_of: ROOM, room_persona_id: 'lin-lan' },
      updated_at: ts(60),
    }),
    personaSession(LAN_ONE, 'xiao-lan', LAN_FACE, { title: '证书续期要多久', last_seq: 6, updated_at: ts(35) }),
    personaSession(LAN_TWO, 'xiao-lan', LAN_FACE, { title: '对比表要保留旧版本吗', last_seq: 4, updated_at: ts(90) }),
    sessionRecord('session_plain_1', { title: '整理 0.30 的回归问题', workspace_id: WS_APP, updated_at: ts(400) }),
  ],
  snapshots: {
    [LIN]: {
      messages: [
        userMsg(LIN, '这周能发 0.31 吗？', 90),
        assistantMsg(LIN, ['能。差两件事：签名证书续期、changelog 还缺 3 条（#812 #815 #820）。其余 47 个提交都已合入。'], 88),
        userMsg(LIN, '先把发布清单列出来。', 12),
        assistantMsg(LIN, ['发布清单（0.31）：\n\n- 阻塞：签名证书续期\n- 待办：changelog 三条、发布公告\n- 已完成：47 个提交合入、回归测试通过'], 10),
      ],
    },
    [LIN_RELEASE]: {
      messages: [
        userMsg(LIN_RELEASE, '把 0.31 的阻塞项列一下。', 40),
        assistantMsg(LIN_RELEASE, ['阻塞项只有一个：桌面端签名证书还没续期。'], 38),
      ],
    },
    [LAN_ONE]: { messages: [assistantMsg(LAN_ONE, ['证书续期要 1–2 个工作日，供应商今天下午能受理。'], 35)] },
    [LAN_TWO]: { messages: [assistantMsg(LAN_TWO, ['建议保留，标注「旧版」：读者会拿它对比。'], 90)] },
    [CHE]: { messages: [] },
  },
  rooms: [
    {
      room: {
        version: 1, id: ROOM, name: '发布房间', host: 'lin-lan', mode: 'mention',
        // The wire shape is a discriminated union on `kind` (protocol
        // `roomMemberSchema`): a persona's seat carries `kind: 'persona'`, and
        // the room/member filters in the GUI read exactly that discriminator.
        members: [{ kind: 'persona', personaId: 'lin-lan', sessionId: LIN_ROOM, muted: false }],
        budget: { botMessagesPerUserMessage: 12 }, workspace: 'C:/fixture/workshop', createdAt: ts(300),
        generation: 0, paused: false, budgetUsed: 0, userMessageCount: 1, cursors: {},
      },
      log: [
        { id: 'r1', at: ts(60), kind: 'message', from: 'user', text: '这周能发 0.31 吗？@林岚', mentions: ['lin-lan'] },
        { id: 'r2', at: ts(59), kind: 'message', from: 'lin-lan', text: '能，差两件事。', mentions: [] },
      ],
      usage: { members: {} },
    },
  ],
  memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} },
};
