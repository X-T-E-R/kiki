/**
 * memory — the /memory console with memory already on, two scopes populated,
 * and a journal that makes Undo real.
 *
 * Global holds preference/feedback entries plus one archived one (so "Show
 * archived" has something to reveal); the fixture workspace holds project and
 * reference entries, one pinned. `approval: 'auto'` is the shipped default, so
 * there is no Inbox tab here — `memory-review` covers that.
 *
 * The session carries a completed MemoryWrite → MemoryRead → MemorySearch chain
 * so the timeline's quiet memory rows are proven in the same run.
 */

import { assistantMsg, sessionRecord, toolResultMsg, ts, userMsg, fid } from './helpers.mjs';

const SID = 'session_fixture_memory';
const WS_APP = 'wd_fixture_000000000000';
const WS_DOCS = 'wd_docs_site_000000000000';

const WRITE = fid('call');
const READ = fid('call');
const SEARCH = fid('call');

const workspaces = [
  { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 1, pinned: true },
  { id: WS_DOCS, root: 'C:/fixture/docs-site', name: 'docs-site', created_at: ts(9_000), last_opened_at: ts(220), session_count: 0, pinned: false },
];

function entry(fields) {
  return {
    status: 'active',
    pinned: false,
    created: ts(2_880),
    updated: ts(120),
    source: { writer: 'agent', session: SID, turn: 12 },
    reason: '',
    ...fields,
  };
}

const globalEntries = [
  entry({
    id: 'm_20260926_a1b2c3',
    type: 'user',
    title: 'Answers in Chinese, code comments in English',
    body: '回复用中文；代码注释、提交信息和标识符保持英文。',
    reason: '用户在第一次会话里说明的偏好',
    source: { writer: 'user' },
    updated: ts(60),
  }),
  entry({
    id: 'm_20260926_d4e5f6',
    type: 'feedback',
    title: 'Do not add summary Markdown files after a task',
    body: 'Finishing a task does not mean writing a HANDOFF or SUMMARY file. Only create documents that were asked for.',
    reason: 'User corrected this twice in the same week',
    updated: ts(300),
  }),
  entry({
    id: 'm_20260924_998877',
    type: 'reference',
    title: 'Design notes live in analyses/',
    body: 'Dated design records are kept under analyses/<date>-<topic>.md.',
    updated: ts(1_400),
  }),
  entry({
    id: 'm_20260901_oldold',
    type: 'project',
    title: 'Release checklist lived in the old wiki',
    body: 'Superseded by the checklist in the repo; kept for history.',
    status: 'archived',
    updated: ts(20_000),
  }),
];

const workspaceEntries = [
  entry({
    id: 'm_20260927_111222',
    type: 'project',
    title: 'Install and run scripts with pnpm, never npm',
    body: 'The repo root has pnpm-lock.yaml. npm install writes package-lock.json and breaks the workspace links.',
    reason: 'npm install broke the lockfile on 09-27',
    pinned: true,
    updated: ts(30),
  }),
  entry({
    id: 'm_20260927_333444',
    type: 'project',
    title: 'GUI proof needs the fixture server, not a live model',
    body: 'pnpm --filter @kiki/gui proof boots the fixture server and vite itself; a live backend is never needed for screenshots.',
    updated: ts(90),
  }),
  entry({
    id: 'm_20260925_555666',
    type: 'reference',
    title: 'Board storage settings are per workspace',
    body: 'Task board storage is chosen in the workspace settings, not globally.',
    updated: ts(900),
  }),
];

const messages = [
  userMsg(SID, 'Remember that this repo uses pnpm, then check what you already know about the proof command.', 22),
  assistantMsg(SID, [
    'Noting the build rule first.',
    { toolUse: { id: WRITE, name: 'MemoryWrite', input: {
      action: 'create',
      scope: 'workspace',
      type: 'project',
      title: 'Install and run scripts with pnpm, never npm',
      body: 'The repo root has pnpm-lock.yaml. npm install writes package-lock.json and breaks the workspace links.',
      reason: 'npm install broke the lockfile on 09-27',
    } } },
  ], 21),
  toolResultMsg(SID, WRITE, JSON.stringify({
    id: 'm_20260927_111222',
    title: 'Install and run scripts with pnpm, never npm',
    scope: 'workspace',
    status: 'active',
    revision: 'rev_fixture_write',
    operation_id: 'op_fixture_seeded',
  }), 21),
  assistantMsg(SID, [
    { toolUse: { id: SEARCH, name: 'MemorySearch', input: { query: 'proof command', scope: 'workspace' } } },
  ], 20),
  toolResultMsg(SID, SEARCH, JSON.stringify([
    { id: 'm_20260927_333444', title: 'GUI proof needs the fixture server, not a live model', type: 'project', snippet: 'pnpm --filter @kiki/gui proof boots the fixture server and vite itself', score: 3 },
  ]), 20),
  assistantMsg(SID, [
    { toolUse: { id: READ, name: 'MemoryRead', input: { id: 'm_20260927_333444' } } },
  ], 19),
  toolResultMsg(SID, READ, JSON.stringify([
    { id: 'm_20260927_333444', type: 'project', title: 'GUI proof needs the fixture server, not a live model', body: 'pnpm --filter @kiki/gui proof boots the fixture server and vite itself; a live backend is never needed for screenshots.' },
  ]), 19),
  assistantMsg(SID, [
    'Saved the pnpm rule, and the proof runs through the fixture server — no live model needed.',
  ], 19),
];

export default {
  workspaces,
  sessions: [sessionRecord(SID, { title: 'Fixture: memory', workspace_id: WS_APP })],
  snapshots: { [SID]: { messages } },
  memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} },
  memoryEntries: {
    global: globalEntries,
    [`workspace:${WS_APP}`]: workspaceEntries,
    [`workspace:${WS_DOCS}`]: [],
  },
  // One prior write per scope, so the detail pane's history has an undoable
  // operation without the walker having to make a change first.
  memoryJournal: {
    global: [{
      operationId: 'op_fixture_global_1',
      action: 'create',
      id: 'm_20260926_d4e5f6',
      at: ts(300),
      writer: 'agent',
      before: null,
      beforeRevision: null,
      afterRevision: 'rev_seeded',
    }],
    [`workspace:${WS_APP}`]: [{
      operationId: 'op_fixture_seeded',
      action: 'create',
      id: 'm_20260927_111222',
      at: ts(30),
      writer: 'agent',
      before: null,
      beforeRevision: null,
      afterRevision: 'rev_seeded',
    }],
  },
};
