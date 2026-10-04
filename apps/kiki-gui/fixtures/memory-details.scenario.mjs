import memory from './memory.scenario.mjs';
import { sessionRecord, ts } from './helpers.mjs';

const HOME = 'wd_bot_home_111111111111';
const BOT = 'session_memory_bot_home';
const PERSONA = 'lin-lan';
const entry = (fields) => ({ status: 'active', pinned: false, created: ts(4000), updated: ts(90), source: { writer: 'agent', session: BOT }, reason: '', ...fields });
const previous = entry({ id: 'm_release_old', type: 'project', title: '发布前手动核对安装包', body: '发版前手动打开安装包，确认版本号和快捷方式。\n\n完成后在发布记录中写下验证时间。', reason: '最初的发布约定', revision: 'revision_before_archive' });
const retired = { ...previous, status: 'archived', updated: ts(20), reason: '安装包验证已纳入自动化流水线，手工清单不再使用。' };
const raw = ({ body, revision: _revision, ...meta }) => `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;

export default {
  ...memory,
  workspaces: [...memory.workspaces, { id: HOME, root: 'C:/fixture/bots/lin-lan', name: '林岚的工作区', created_at: ts(4000), last_opened_at: ts(4), session_count: 1, pinned: false }],
  sessions: [...memory.sessions, sessionRecord(BOT, { title: '林岚', workspace_id: HOME, metadata: { cwd: 'C:/fixture/bots/lin-lan', bot_persona_id: PERSONA } })],
  personas: [{ definition: { id: PERSONA, name: '林岚', title: '发布协调', description: '负责版本发布的协调。', memory: { shared: [] } } }],
  bots: [{ personaId: PERSONA, name: '林岚', title: '发布协调', homeSessionId: BOT, pinned: true, hidden: false }],
  memoryEntries: {
    ...memory.memoryEntries,
    [`persona:${PERSONA}`]: [entry({ id: 'm_bot_checklist', type: 'feedback', title: '发布之前，先给我一份清单', body: '任何发布动作之前先列出版本、变更和验证结果，收到确认后再执行。', reason: '用户希望亲自确认发布范围', pinned: true })],
    [`workspace:${HOME}/persona:${PERSONA}`]: [
      entry({ id: 'm_bot_notes', type: 'project', title: '发布说明和回归记录放在一起', body: '每个版本的发布说明与回归记录保存在同一目录，方便后续追溯。', reason: '沿用项目的发布约定' }),
      retired,
    ],
  },
  memoryJournal: {
    ...memory.memoryJournal,
    [`workspace:${HOME}/persona:${PERSONA}`]: [
      { operationId: 'op_memory_archive', action: 'archive', id: retired.id, at: retired.updated, writer: 'user', before: raw(previous), beforeRevision: previous.revision, afterRevision: 'revision_after_archive' },
      // A subsequent snapshot permits exact reconstruction of the archive result.
      { operationId: 'op_memory_later', action: 'update', id: retired.id, at: ts(10), writer: 'user', before: raw(retired), beforeRevision: 'revision_after_archive', afterRevision: 'revision_later' },
    ],
  },
};
