/**
 * memory-review — `approval = 'review'`, the only configuration where the
 * Inbox tab exists. Two pending entries wait for Keep / Discard; the active
 * list is short so the tab and its count are the subject of the shot.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_memory_review';
const WS_APP = 'wd_fixture_000000000000';

function entry(fields) {
  return {
    status: 'active',
    pinned: false,
    created: ts(2_000),
    updated: ts(200),
    source: { writer: 'agent', session: SID, turn: 4 },
    reason: '',
    ...fields,
  };
}

export default {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 1, pinned: false },
  ],
  sessions: [sessionRecord(SID, { title: 'Fixture: memory review', workspace_id: WS_APP })],
  snapshots: { [SID]: { messages: [] } },
  memory: { enabled: true, approval: 'review', budget: 2_000, workspaces: {} },
  memoryEntries: {
    global: [
      entry({
        id: 'm_20260926_a1b2c3',
        type: 'user',
        title: 'Answers in Chinese, code comments in English',
        body: '回复用中文；代码注释、提交信息和标识符保持英文。',
        source: { writer: 'user' },
      }),
      entry({
        id: 'm_20260928_pend01',
        type: 'feedback',
        title: 'Prefers smaller commits over one large one',
        body: 'Split a landing into reviewable commits per coherent change instead of one squashed commit.',
        reason: 'Said so while reviewing the batch on 09-28',
        status: 'pending',
        updated: ts(12),
      }),
      entry({
        id: 'm_20260928_pend02',
        type: 'project',
        title: 'CI runs the flake workspace sync check',
        body: 'scripts/check-nix-workspace.mjs runs in CI only; keep flake.nix in sync by hand in the same change.',
        reason: 'Learned from a failing CI run',
        status: 'pending',
        updated: ts(40),
      }),
    ],
    [`workspace:${WS_APP}`]: [],
  },
  memoryJournal: {},
};
