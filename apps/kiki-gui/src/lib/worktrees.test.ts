import { describe, expect, it } from 'vitest';

import type { WorktreeInspection, WorktreeRecord } from '@kiki/protocol';

import { hasLoss, sameInspection, visibleWorktrees, worktreeLoss } from './worktrees';

const clean: WorktreeInspection = {
  inspectedAt: 1, failed: false, dirtyFiles: 0, untrackedFiles: 0, aheadOfBase: 0, unpushedCommits: 0, ignoredNonDisposable: [],
};

function record(id: string, state: WorktreeRecord['state'], updatedAt: number): WorktreeRecord {
  return {
    id, version: 1,
    repo: { fingerprint: 'fp', commonDir: '/r/.git', sourceRoot: '/r', workspaceId: 'wd_x' },
    path: `/home/.kiki/worktrees/fp/${id}`, branch: `kiki/${id}`, branchCreated: true,
    base: { mode: 'head', ref: 'HEAD', commit: 'abc' },
    owner: { kind: 'session', sessionId: `session_${id}` },
    state, createdAt: 0, updatedAt,
  };
}

describe('worktree loss', () => {
  it('reports nothing to lose for a clean checkout', () => {
    expect(hasLoss(worktreeLoss(clean))).toBe(false);
  });

  it('maps each loss kind to the confirmation the server expects', () => {
    expect(worktreeLoss({ ...clean, dirtyFiles: 2 })).toEqual({ dirty: true, ignored: false, unpushed: false });
    expect(worktreeLoss({ ...clean, unpushedCommits: 1 })).toEqual({ dirty: false, ignored: false, unpushed: true });
    expect(worktreeLoss({ ...clean, ignoredNonDisposable: ['.env.local'] })).toEqual({ dirty: false, ignored: true, unpushed: false });
  });

  it('treats a changed count or ignored list as a different inspection', () => {
    expect(sameInspection(clean, { ...clean, inspectedAt: 99 })).toBe(true);
    expect(sameInspection(clean, { ...clean, dirtyFiles: 1 })).toBe(false);
    expect(sameInspection(clean, { ...clean, ignoredNonDisposable: ['a'] })).toBe(false);
  });
});

describe('visibleWorktrees', () => {
  it('drops removed rows and puts the most recently changed first', () => {
    const rows = visibleWorktrees([record('a', 'ready', 1), record('b', 'removed', 5), record('c', 'remove_failed', 3)]);
    expect(rows.map((row) => row.id)).toEqual(['c', 'a']);
  });
});
