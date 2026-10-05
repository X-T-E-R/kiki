/**
 * memory-provenance — the states the S4 management surface has to tell apart,
 * and one closed loop the reader can actually walk.
 *
 * The three entries in `global` are deliberately different facts:
 *   - one recorded from what the user said (`basis.human`) with nothing to
 *     re-check, the ordinary case;
 *   - one Kiki worked out for itself (`basis.derived`) that names what must be
 *     checked first, so the row can say "check first" without claiming the
 *     content is the user's instruction;
 *   - one whose endpoint has passed, which is a lead and not a premise.
 * A persona-scoped entry proves a persona write is located in its own
 * namespace instead of the session's workspace.
 *
 * The session's timeline carries the three write outcomes a turn produces:
 * applied, pending, and unchanged. Only the first two name an operation, so
 * only they carry Undo. A later write to the same entry is what makes an
 * earlier undo refuse instead of replacing the newer version.
 *
 * This scenario is mock data for a contract the runtime serves: the receipt
 * shapes here match the store and tool payloads, and the page is exercised
 * against the same REST routes a live server answers.
 */

import { createHash } from 'node:crypto';

import memory from './memory.scenario.mjs';
import { assistantMsg, sessionRecord, toolResultMsg, ts, userMsg, fid } from './helpers.mjs';

const SID = 'session_fixture_memory_provenance';
const WS_APP = 'wd_fixture_000000000000';
const PERSONA = 'lin-lan';

const WRITE_APPLIED = fid('call');
const WRITE_PENDING = fid('call');
const WRITE_UNCHANGED = fid('call');
const WRITE_PERSONA = fid('call');
const SEARCH = fid('call');

const entry = (fields) => ({
  status: 'active',
  pinned: false,
  created: ts(4_000),
  updated: ts(60),
  source: { writer: 'agent', session: SID, turn: 6 },
  reason: '',
  ...fields,
});

/**
 * The receipt `MemoryWrite` emits: the flat scope string beside the full
 * `owner_scope`, the copyable `target`, the stored `entry`, and the outcome.
 * Field-for-field the tool's own JSON, so the row is read from a real payload.
 */
const receipt = (fields) => ({
  action: 'update',
  outcome: fields.outcome,
  id: fields.id,
  title: fields.title,
  scope: fields.owner_scope.kind,
  owner_scope: fields.owner_scope,
  target: { scope: fields.owner_scope.kind, id: fields.id, expected_revision: fields.revision },
  status: 'active',
  revision: fields.revision,
  operation_id: fields.operation_id,
  entry: fields.entry,
  ...fields.extra,
});

const appliedEntry = entry({
  id: 'm_20261005_111111',
  type: 'feedback',
  title: 'Long tasks: report at decision points, not every step',
  body: 'While a long task runs, report only when a decision is needed or the plan changes. Routine progress does not need a message.',
  reason: '用户在长时间任务里明确要求的节奏',
  source: { writer: 'agent', session: SID, turn: 6 },
  basis: { kind: 'human', note: '用户说「跑久一点没关系，到要拍板的时候再说」，并要求同一会话内生效。', refs: ['session_fixture_memory_provenance#turn-6'] },
  updated: ts(40),
});

const derivedEntry = entry({
  id: 'm_20261005_222222',
  type: 'project',
  title: '本机模型实验用的 GPU 排期',
  body: '这台机器的独占 GPU 时段按季度调整，训练任务开始前先看当前排期。',
  reason: 'Kiki 从排期文件归纳，未回源到用户原话',
  basis: { kind: 'derived', note: '数字与时段来自 Kiki 自己排的方案，用户只要求「别撞上别人的任务」。', refs: ['analyses/2026-10-05-memory-redesign-astra.md#evidence'] },
  validity: { check: '开始任何占用 GPU 的任务前，核对当前排期。' },
  updated: ts(120),
});

const expiredEntry = entry({
  id: 'm_20261005_333333',
  type: 'project',
  title: '一次性演示环境的临时授权',
  body: '演示环境在授权期内可临时开放给外部访问。',
  reason: '当时为一次演示申请，授权已到期',
  basis: { kind: 'observed', note: '依据是当时的授权单，已随授权一同到期。' },
  // A passed endpoint does not retire anything by itself: the entry stays
  // stored and still listed, and the row is what says it is a lead.
  validity: { check: '再次对外开放前，重新取得书面授权。', until: '2026-09-01T00:00:00Z' },
  updated: ts(2_000),
});

/** An entry retired into another, so the reader can follow the merge. */
const mergedEntry = entry({
  id: 'm_20261005_444444',
  type: 'feedback',
  title: '旧版：每一步都汇报进度',
  body: '每完成一步就向用户汇报一次进度。',
  reason: '内容已由新的汇报节奏条目完整承接',
  status: 'archived',
  covered_by: { id: appliedEntry.id, revision: 'revision-merge-target' },
  updated: ts(500),
});

const personaEntry = entry({
  id: 'm_20261005_555555',
  type: 'user',
  title: '林岚负责发布协调，需要先确认发布范围',
  body: '任何发布动作之前先列出版本、变更和验证结果，收到确认后再执行。',
  reason: '角色的工作约定',
  source: { writer: 'user' },
  basis: { kind: 'human', note: '在角色创建时由用户直接写明。' },
  updated: ts(20),
});

const pendingEntry = entry({
  id: 'm_20261005_999999', type: 'feedback', status: 'pending',
  title: '评审前先把改动拆成可读的小批',
  body: '提交前先按可独立审阅的改动拆批。',
  reason: '从刚才的评审反馈里归纳',
  basis: { kind: 'derived', note: 'Kiki 从评审意见归纳，用户没有直接下过这条指令。' },
  updated: ts(38),
});

const messages = [
  userMsg(SID, '记住：长任务里只在要拍板或计划变了的时候汇报。顺便把之前「每步都汇报」那条并进去。', 42),
  assistantMsg(SID, [
    { toolUse: { id: WRITE_APPLIED, name: 'MemoryWrite', input: {
      action: 'update',
      id: appliedEntry.id,
      scope: 'global',
      type: 'feedback',
      title: appliedEntry.title,
      body: appliedEntry.body,
      reason: appliedEntry.reason,
      basis: appliedEntry.basis,
    } } },
  ], 41),
  toolResultMsg(SID, WRITE_APPLIED, JSON.stringify(receipt({
    id: appliedEntry.id,
    title: appliedEntry.title,
    revision: fixtureRevision(appliedEntry),
    operation_id: 'op_fixture_provenance_applied',
    outcome: 'applied',
    owner_scope: { kind: 'global' },
    entry: { ...appliedEntry, revision: fixtureRevision(appliedEntry) },
  })), 41),
  assistantMsg(SID, [
    '汇报节奏按新的写了。再确认一次旧的那条是不是已经一样。',
    { toolUse: { id: WRITE_UNCHANGED, name: 'MemoryWrite', input: {
      action: 'update',
      id: appliedEntry.id,
      scope: 'global',
      type: 'feedback',
      title: appliedEntry.title,
      body: appliedEntry.body,
      reason: '复核是否已经一致',
    } } },
  ], 40),
  toolResultMsg(SID, WRITE_UNCHANGED, JSON.stringify(receipt({
    id: appliedEntry.id,
    title: appliedEntry.title,
    revision: fixtureRevision(appliedEntry),
    operation_id: null,
    outcome: 'unchanged',
    owner_scope: { kind: 'global' },
    entry: { ...appliedEntry, revision: fixtureRevision(appliedEntry) },
  })), 40),
  assistantMsg(SID, [
    { toolUse: { id: WRITE_PENDING, name: 'MemoryWrite', input: {
      action: 'create',
      scope: 'global',
      type: 'feedback',
      title: '评审前先把改动拆成可读的小批',
      body: '提交前先按可独立审阅的改动拆批。',
      reason: '从刚才的评审反馈里归纳',
      basis: { kind: 'derived', note: 'Kiki 从评审意见归纳，用户没有直接下过这条指令。' },
    } } },
  ], 38),
  toolResultMsg(SID, WRITE_PENDING, JSON.stringify(receipt({
    id: pendingEntry.id,
    title: pendingEntry.title,
    revision: fixtureRevision(pendingEntry),
    operation_id: 'op_fixture_provenance_pending',
    outcome: 'pending',
    owner_scope: { kind: 'global' },
    entry: { ...pendingEntry, revision: fixtureRevision(pendingEntry) },
    extra: { action: 'create', status: 'pending' },
  })), 38),
  assistantMsg(SID, [
    { toolUse: { id: WRITE_PERSONA, name: 'MemoryWrite', input: {
      action: 'create',
      scope: 'persona',
      type: 'user',
      title: personaEntry.title,
      body: personaEntry.body,
      reason: personaEntry.reason,
      basis: personaEntry.basis,
    } } },
  ], 30),
  toolResultMsg(SID, WRITE_PERSONA, JSON.stringify(receipt({
    id: personaEntry.id,
    title: personaEntry.title,
    revision: 'rev_fixture_persona',
    operation_id: 'op_fixture_provenance_persona',
    outcome: 'applied',
    owner_scope: { kind: 'persona', personaId: PERSONA },
    entry: { ...personaEntry, revision: 'rev_fixture_persona' },
  })), 30),
  assistantMsg(SID, [
    { toolUse: { id: SEARCH, name: 'MemorySearch', input: { query: '汇报 节奏', scope: 'global' } } },
  ], 20),
  toolResultMsg(SID, SEARCH, JSON.stringify({
    items: [{
      id: appliedEntry.id,
      title: appliedEntry.title,
      type: 'feedback',
      status: 'active',
      revision: fixtureRevision(appliedEntry),
      scope: { kind: 'global' },
      target: { scope: 'global', id: appliedEntry.id, expected_revision: fixtureRevision(appliedEntry) },
      basis_kind: 'human',
      applicability: 'unrecorded',
      snippet: 'While a long task runs, report only when a decision is needed or the plan changes.',
      score: 1_001_000,
    }],
    mode: 'search',
    next_cursor: null,
    coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: true, complete: true, warnings: [] },
  }), 20),
  assistantMsg(SID, ['汇报节奏、待处理的评审分批提案和角色的发布约定都记下了。'], 19),
];

const raw = ({ body, revision: _revision, ...meta }) => `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;

/**
 * The deterministic revision the fixture server computes for an entry. A
 * journal record carries the revisions that were real at the time, so they are
 * derived here rather than written by hand: a plausible-looking literal would
 * render fine in the version panel and then turn every undo into a false
 * conflict, because the store checks the current revision against the record.
 */
function fixtureRevision(entry) {
  return createHash('sha256').update(JSON.stringify({
    title: entry.title, body: entry.body, type: entry.type, status: entry.status, pinned: entry.pinned,
    basis: entry.basis, validity: entry.validity, covered_by: entry.covered_by,
  })).digest('hex');
}

export default {
  ...memory,
  memory: { ...memory.memory, approval: 'review' },
  sessions: [...memory.sessions, sessionRecord(SID, { title: 'Fixture: memory provenance', workspace_id: WS_APP })],
  snapshots: { [SID]: { messages } },
  memoryEntries: {
    ...memory.memoryEntries,
    global: [appliedEntry, derivedEntry, expiredEntry, mergedEntry, pendingEntry],
    [`persona:${PERSONA}`]: [personaEntry],
  },
  memoryJournal: {
    ...memory.memoryJournal,
    global: [
      {
        operationId: 'op_fixture_provenance_pending', action: 'create', id: pendingEntry.id,
        at: ts(38), writer: 'agent', before: null, beforeRevision: null,
        afterRevision: fixtureRevision(pendingEntry),
      },
      {
        operationId: 'op_fixture_provenance_applied',
        action: 'update',
        id: appliedEntry.id,
        at: ts(40),
        writer: 'agent',
        before: raw(entry({ ...appliedEntry, basis: undefined, updated: ts(300) })),
        beforeRevision: fixtureRevision(entry({ ...appliedEntry, basis: undefined, updated: ts(300) })),
        afterRevision: fixtureRevision(appliedEntry),
      },
      {
        operationId: 'op_fixture_provenance_merge',
        action: 'archive',
        id: mergedEntry.id,
        at: ts(500),
        writer: 'agent',
        before: raw({ ...mergedEntry, status: 'active', covered_by: undefined }),
        beforeRevision: fixtureRevision({ ...mergedEntry, status: 'active', covered_by: undefined }),
        afterRevision: fixtureRevision(mergedEntry),
      },
      {
        operationId: 'op_fixture_global_1',
        action: 'create',
        id: 'm_20260926_d4e5f6',
        at: ts(300),
        writer: 'agent',
        before: null,
        beforeRevision: null,
        afterRevision: 'rev_seeded',
      },
    ],
  },
};
