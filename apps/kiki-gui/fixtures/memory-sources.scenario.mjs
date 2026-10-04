/**
 * memory-sources — the /memory console under scale: 120+ workspaces behind the
 * searchable scope picker, several personas (one a Bot with a home workspace),
 * and a journal rich enough for the history panel (before/after snapshots,
 * two records to step through). Extends the base memory scenario.
 */

import { createHash } from 'node:crypto';

import memory from './memory.scenario.mjs';
import { sessionRecord, ts } from './helpers.mjs';

const HOME = 'wd_bot_home_111111111111';
const BOT = 'session_memory_bot_home';
const PERSONA = 'lin-lan';
const DOCS = 'wd_docs_site_000000000000';

const entry = (fields) => ({ status: 'active', pinned: false, created: ts(4000), updated: ts(90), source: { writer: 'agent', session: BOT }, reason: '', ...fields });
const previous = entry({ id: 'm_release_old', type: 'project', title: '发布前手动核对安装包', body: '发版前手动打开安装包，确认版本号和快捷方式。\n\n完成后在发布记录中写下验证时间。', reason: '最初的发布约定', revision: 'revision_before_archive' });
const retired = { ...previous, status: 'archived', updated: ts(20), reason: '安装包验证已纳入自动化流水线，手工清单不再使用。' };
const raw = ({ body, revision: _revision, ...meta }) => `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;
/** The server derives a live revision from exactly these fields (`memoryRevision`), so a
 *  journal record can name a revision the page will actually read back. */
const liveRevision = (item) => createHash('sha256').update(JSON.stringify({ title: item.title, body: item.body, type: item.type, status: item.status, pinned: item.pinned })).digest('hex');

// MEM-DETAIL-01: two retired entries in the same slice — one whose replacement
// lives in this namespace (the detail pane can offer a real link) and one whose
// replacement lives in another namespace (nothing to open, so it must stay
// text). `m_bot_checklist` is the replacement of the second and lives in
// `persona:lin-lan`, i.e. a different namespace from this slice.
const notesNow = entry({ id: 'm_bot_notes_new', type: 'project', title: '发布说明改用 CHANGELOG 段落', body: '发布说明不再单独开文件，直接写进 CHANGELOG 的对应版本段落。', reason: '取代了单独写发布说明文件的旧约定', updated: ts(40) });
const notesOld = entry({ id: 'm_bot_notes_old', status: 'superseded', type: 'project', title: '发布说明单独写文件', body: '每个版本的发布说明单独建一个文件放在 docs/releases 下。', superseded_by: 'm_bot_notes_new', updated: ts(60) });
const checklistOld = entry({ id: 'm_bot_checklist_old', status: 'superseded', type: 'project', title: '发布清单手工维护', body: '发布前手动维护一份清单，逐项打勾后再执行。', superseded_by: 'm_bot_checklist', updated: ts(70) });

const named = [
  ['wd_demo_docs_api_0000', 'docs-api', 'C:/fixture/docs-api'],
  ['wd_demo_docs_i18n_0000', 'docs-translations', 'C:/fixture/docs-translations'],
  ['wd_demo_billing_000000', 'billing-service', 'C:/fixture/billing-service'],
  ['wd_demo_relay_00000000', 'gateway-relay', 'C:/fixture/gateway-relay'],
];
const words = ['atlas', 'harbor', 'delta', 'ember', 'fossil', 'granite', 'quartz', 'cinder', 'maple', 'otter', 'falcon', 'zephyr', 'onyx', 'prairie', 'ledger', 'meadow', 'basalt', 'willow', 'heron', 'tundra'];
const generated = Array.from({ length: 118 }, (_, index) => {
  const word = words[index % words.length];
  const serial = Math.floor(index / words.length) + 1;
  return {
    id: `wd_bulk_${String(index).padStart(4, '0')}`,
    root: `C:/fixture/bulk/${word}-${serial}`,
    name: `${word}-${serial}`,
    created_at: ts(9000 + index),
    last_opened_at: ts(5000 + index),
    session_count: 0,
    pinned: false,
  };
});

export default {
  ...memory,
  workspaces: [
    ...memory.workspaces,
    { id: HOME, root: 'C:/fixture/bots/lin-lan', name: '林岚的工作区', created_at: ts(4000), last_opened_at: ts(4), session_count: 1, pinned: false },
    ...named.map(([id, name, root]) => ({ id, root, name, created_at: ts(8000), last_opened_at: ts(300), session_count: 0, pinned: false })),
    ...generated,
  ],
  sessions: [...memory.sessions, sessionRecord(BOT, { title: '林岚', workspace_id: HOME, metadata: { cwd: 'C:/fixture/bots/lin-lan', bot_persona_id: PERSONA } })],
  personas: [
    { definition: { id: PERSONA, name: '林岚', title: '发布协调', description: '负责版本发布的协调。', memory: { shared: ['global'] } } },
    { definition: { id: 'shen-zhou', name: '沈舟', title: '科研助手', description: '整理文献与实验记录。' } },
    { definition: { id: 'a-li', name: '阿梨', title: '翻译', description: '中英互译与润色。' } },
    { definition: { id: 'mo-qi', name: '墨七', title: '代码审查', description: '审查后端服务的改动。' } },
  ],
  bots: [{ personaId: PERSONA, name: '林岚', title: '发布协调', homeSessionId: BOT, pinned: true, hidden: false }],
  memoryEntries: {
    ...memory.memoryEntries,
    [`workspace:${DOCS}`]: [
      entry({ id: 'm_docs_build', type: 'project', title: '文档站用 pnpm docs:build 构建', body: '构建命令是 pnpm docs:build，产物在 docs/.vitepress/dist。', source: { writer: 'user' }, updated: ts(50) }),
      entry({ id: 'm_docs_style', type: 'feedback', title: '示例代码不要省略错误处理', body: '文档里的示例必须包含错误处理分支，读者会直接复制。', updated: ts(200) }),
    ],
    [`persona:${PERSONA}`]: [entry({ id: 'm_bot_checklist', type: 'feedback', title: '发布之前，先给我一份清单', body: '任何发布动作之前先列出版本、变更和验证结果，收到确认后再执行。', reason: '用户希望亲自确认发布范围', pinned: true })],
    [`workspace:${HOME}/persona:${PERSONA}`]: [
      entry({ id: 'm_bot_notes', type: 'project', title: '发布说明和回归记录放在一起', body: '每个版本的发布说明与回归记录保存在同一目录，方便后续追溯。', reason: '沿用项目的发布约定' }),
      retired,
      notesNow,
      notesOld,
      checklistOld,
    ],
  },
  memoryJournal: {
    ...memory.memoryJournal,
    [`workspace:${HOME}/persona:${PERSONA}`]: [
      { operationId: 'op_memory_archive', action: 'archive', id: retired.id, at: retired.updated, writer: 'user', before: raw(previous), beforeRevision: previous.revision, afterRevision: 'revision_after_archive' },
      // The newest record's "after" is the entry as it stands now, so its
      // revision has to be the one the store hands the page.
      { operationId: 'op_memory_later', action: 'update', id: retired.id, at: ts(10), writer: 'user', before: raw(retired), beforeRevision: 'revision_after_archive', afterRevision: liveRevision(retired) },
      // Names the revision the retired entries were superseded at, so the
      // detail pane can read their retirement reason from the replacement.
      { operationId: 'op_memory_supersede_notes', action: 'supersede', id: notesNow.id, at: notesNow.updated, writer: 'agent', before: null, beforeRevision: null, afterRevision: liveRevision(notesNow) },
    ],
  },
};
