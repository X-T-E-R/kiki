import { describe, expect, it } from 'vitest';

import type { Task, Workspace } from '@moonshot-ai/protocol';

import {
  compareWorkspacesByRecency,
  filterSelectOptions,
  filterWorkspaces,
  sortTasks,
  sortWorkspacesByRecency,
} from './sorting';

function makeWorkspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    name: overrides.id,
    root: `C:/work/${overrides.id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: '2026-01-01T00:00:00.000Z',
    session_count: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    session_id: 'sess-1',
    kind: 'bash',
    description: `task ${overrides.id}`,
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('compareWorkspacesByRecency / sortWorkspacesByRecency', () => {
  it('orders most-recently-opened first', () => {
    const sorted = sortWorkspacesByRecency([
      makeWorkspace({ id: 'old', last_opened_at: '2026-01-01T00:00:00.000Z' }),
      makeWorkspace({ id: 'new', last_opened_at: '2026-03-01T00:00:00.000Z' }),
      makeWorkspace({ id: 'mid', last_opened_at: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((w) => w.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sinks entries without a usable timestamp below timestamped ones', () => {
    const sorted = sortWorkspacesByRecency([
      makeWorkspace({ id: 'no-date', last_opened_at: '' }),
      makeWorkspace({ id: 'dated', last_opened_at: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((w) => w.id)).toEqual(['dated', 'no-date']);
  });

  it('breaks ties by name deterministically (code units, not locale)', () => {
    const sorted = sortWorkspacesByRecency([
      makeWorkspace({ id: 'b', name: 'beta' }),
      makeWorkspace({ id: 'a', name: 'Alpha' }),
      makeWorkspace({ id: 'c', name: 'alpha' }),
    ]);
    expect(sorted.map((w) => w.name)).toEqual(['Alpha', 'alpha', 'beta']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeWorkspace({ id: 'old', last_opened_at: '2026-01-01T00:00:00.000Z' }),
      makeWorkspace({ id: 'new', last_opened_at: '2026-03-01T00:00:00.000Z' }),
    ];
    sortWorkspacesByRecency(input);
    expect(input.map((w) => w.id)).toEqual(['old', 'new']);
  });

  it('compareWorkspacesByRecency is a stable total order (id fallback)', () => {
    const a = makeWorkspace({ id: 'wd_a', name: 'same' });
    const b = makeWorkspace({ id: 'wd_b', name: 'same' });
    expect(compareWorkspacesByRecency(a, b)).toBeLessThan(0);
    expect(compareWorkspacesByRecency(b, a)).toBeGreaterThan(0);
    expect(compareWorkspacesByRecency(a, a)).toBe(0);
  });
});

describe('filterWorkspaces', () => {
  const workspaces = [
    makeWorkspace({ id: 'one', name: 'Kiki', root: 'C:/work/kiki' }),
    makeWorkspace({ id: 'two', name: 'Docs', root: '/home/example/docs' }),
  ];

  it('matches name and root case-insensitively', () => {
    expect(filterWorkspaces(workspaces, 'kiki').map((w) => w.id)).toEqual(['one']);
    expect(filterWorkspaces(workspaces, 'EXAMPLE').map((w) => w.id)).toEqual(['two']);
    expect(filterWorkspaces(workspaces, '/home').map((w) => w.id)).toEqual(['two']);
  });

  it('returns a copy of the list for a blank query and [] for no match', () => {
    const all = filterWorkspaces(workspaces, '   ');
    expect(all.map((w) => w.id)).toEqual(['one', 'two']);
    expect(all).not.toBe(workspaces);
    expect(filterWorkspaces(workspaces, 'zzz')).toEqual([]);
  });
});

describe('sortTasks', () => {
  it('puts running tasks first, then newest-created first', () => {
    const sorted = sortTasks([
      makeTask({ id: 'old-done', created_at: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'running-old', status: 'running', created_at: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new-done', created_at: '2026-01-03T00:00:00.000Z' }),
      makeTask({ id: 'running-new', status: 'running', created_at: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(sorted.map((task) => task.id)).toEqual([
      'running-new',
      'running-old',
      'new-done',
      'old-done',
    ]);
  });
});

describe('filterSelectOptions', () => {
  const options = [
    { value: 'a', label: 'Alpha', hint: 'C:/work/alpha' },
    { value: 'b', label: 'Friendly name', keywords: 'model-id-9' },
    { value: 'c', label: 'Gamma' },
  ];

  it('matches label, hint, and keywords case-insensitively', () => {
    expect(filterSelectOptions(options, 'alpha').map((o) => o.value)).toEqual(['a']);
    expect(filterSelectOptions(options, 'work/ALPHA').map((o) => o.value)).toEqual(['a']);
    expect(filterSelectOptions(options, 'MODEL-ID').map((o) => o.value)).toEqual(['b']);
  });

  it('returns everything for a blank query and [] when nothing matches', () => {
    expect(filterSelectOptions(options, '')).toHaveLength(3);
    expect(filterSelectOptions(options, 'nope')).toEqual([]);
  });
});
