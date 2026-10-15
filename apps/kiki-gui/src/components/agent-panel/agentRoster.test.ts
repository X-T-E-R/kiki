import { describe, expect, it } from 'vitest';

import { buildAgentForest } from '@kiki/session-core/session';

import { agentTrail, buildRoster, type RosterAgentRow } from './agentRoster';

const forest = buildAgentForest([], [
  { agentId: 'main', name: 'Main' },
  { agentId: 'lead', parentAgentId: 'main', name: 'Lead', status: 'completed' },
  { agentId: 'worker', parentAgentId: 'lead', name: 'Worker', status: 'running' },
  { agentId: 'probe', parentAgentId: 'worker', name: 'Probe', status: 'running' },
  { agentId: 'done-a', parentAgentId: 'main', name: 'Done A', status: 'completed' },
  { agentId: 'done-b', parentAgentId: 'main', name: 'Done B', status: 'completed' },
  { agentId: 'done-c', parentAgentId: 'main', name: 'Done C', status: 'completed' },
  { agentId: 'done-d', parentAgentId: 'main', name: 'Done D', status: 'completed' },
  { agentId: 'broken', parentAgentId: 'main', name: 'Broken', status: 'failed' },
  { agentId: 'live', parentAgentId: 'main', name: 'Live', status: 'running' },
]);

const base = {
  forest,
  rootId: 'main',
  waiting: new Set(['probe']),
  expanded: new Set<string>(),
  filter: 'all' as const,
  query: '',
  doneOpen: false,
};

const labels = (rows: ReturnType<typeof buildRoster>['rows']) =>
  rows.map((row) => (row.kind === 'group' ? `[${row.count} done]` : (row as RosterAgentRow).node.label));

describe('buildRoster', () => {
  it('counts every agent in the tree and orders by the most urgent agent below', () => {
    const model = buildRoster(base);
    // A failure is not a bucket of its own: it ended like the others.
    expect(model.counts).toEqual({ waiting: 1, running: 2, idle: 0, unknown: 0, ended: 6 });
    expect(model.total).toBe(9);
    // Lead finished, but its grandchild waits on the user: it leads the list.
    expect(labels(model.rows)).toEqual(['Lead', 'Live', '[5 done]']);
    const lead = model.rows[0] as RosterAgentRow;
    expect(lead.expanded).toBe(false);
    expect(lead.childCount).toBe(1);
    expect(lead.waitingBelow).toBe(1);
  });

  it('opens branches on demand and the completed group on demand', () => {
    const model = buildRoster({ ...base, expanded: new Set(['lead', 'worker']), doneOpen: true });
    expect(labels(model.rows)).toEqual(['Lead', 'Worker', 'Probe', 'Live', '[5 done]', 'Broken', 'Done A', 'Done B', 'Done C', 'Done D']);
    expect((model.rows[2] as RosterAgentRow).depth).toBe(2);
  });

  it('flattens a status filter or a search and keeps each match on its trail', () => {
    const waiting = buildRoster({ ...base, filter: 'waiting' });
    expect(labels(waiting.rows)).toEqual(['Probe']);
    expect((waiting.rows[0] as RosterAgentRow).path).toEqual(['Lead', 'Worker']);
    const search = buildRoster({ ...base, query: 'done' });
    expect(labels(search.rows)).toEqual(['Done A', 'Done B', 'Done C', 'Done D']);
  });

  it('scopes to a focused agent and stays linear for hundreds of agents', () => {
    expect(labels(buildRoster({ ...base, rootId: 'lead' }).rows)).toEqual(['Worker']);
    const big = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      ...Array.from({ length: 600 }, (_, index) => ({
        agentId: `a${index}`, parentAgentId: index < 20 ? 'main' : `a${index % 20}`, name: `A${index}`,
        status: (index % 7 === 0 ? 'running' : 'completed') as 'running' | 'completed',
      })),
    ]);
    const started = performance.now();
    const model = buildRoster({ ...base, forest: big, waiting: new Set() });
    expect(performance.now() - started).toBeLessThan(200);
    expect(model.total).toBe(600);
    expect(model.rows.length).toBeLessThanOrEqual(21);
  });

  it('keeps a small settled set inline next to live agents', () => {
    const small = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      { agentId: 'explorer', parentAgentId: 'main', name: 'Explorer', status: 'completed' },
      { agentId: 'a', parentAgentId: 'main', name: 'A', status: 'running' },
      { agentId: 'b', parentAgentId: 'main', name: 'B', status: 'running' },
    ]);
    expect(labels(buildRoster({ ...base, forest: small, waiting: new Set() }).rows)).toEqual(['A', 'B', 'Explorer']);
  });

  it('names the ancestors of a nested agent', () => {
    expect(agentTrail(forest, 'probe')).toEqual(['Lead', 'Worker']);
    expect(agentTrail(forest, 'lead')).toEqual([]);
  });
});


it('folds historical unknown agents apart from idle and finished', () => {
  const registered = buildAgentForest([], [
    { agentId: 'main' },
    ...Array.from({ length: 4 }, (_, index) => ({ agentId: `unknown-${index}`, parentAgentId: 'main', status: 'unknown' as const })),
    { agentId: 'idle', parentAgentId: 'main', status: 'idle' as const },
    ...Array.from({ length: 4 }, (_, index) => ({ agentId: `done-${index}`, parentAgentId: 'main', status: 'completed' as const })),
  ]);
  const model = buildRoster({ ...base, forest: registered, waiting: new Set() });
  expect(model.counts).toEqual({ waiting: 0, running: 0, idle: 1, unknown: 4, ended: 4 });
  expect(model.total).toBe(9);
  expect(model.rows.filter((row): row is RosterAgentRow => row.kind === 'agent').map((row) => row.node.agentId)).toEqual(['idle']);
  expect(model.rows.filter((row) => row.kind === 'group')).toEqual([
    { kind: 'group', bucket: 'unknown', count: 4, open: false },
    { kind: 'group', bucket: 'ended', count: 4, open: false },
  ]);
  const opened = buildRoster({ ...base, forest: registered, waiting: new Set(), unknownOpen: true });
  expect(opened.rows.filter((row): row is RosterAgentRow => row.kind === 'agent').map((row) => row.node.agentId)).toEqual(['idle', 'unknown-0', 'unknown-1', 'unknown-2', 'unknown-3']);
  expect(opened.rows.filter((row) => row.kind === 'group')).toEqual([
    { kind: 'group', bucket: 'unknown', count: 4, open: true },
    { kind: 'group', bucket: 'ended', count: 4, open: false },
  ]);
  const finished = buildRoster({ ...base, forest: registered, waiting: new Set(), doneOpen: true });
  expect(finished.rows.filter((row): row is RosterAgentRow => row.kind === 'agent').map((row) => row.node.agentId)).toEqual(['idle', 'done-0', 'done-1', 'done-2', 'done-3']);
  const few = buildAgentForest([], [
    { agentId: 'main' },
    { agentId: 'live', parentAgentId: 'main', status: 'running' as const },
    ...Array.from({ length: 3 }, (_, index) => ({ agentId: `unknown-${index}`, parentAgentId: 'main', status: 'unknown' as const })),
  ]);
  const inline = buildRoster({ ...base, forest: few, waiting: new Set() });
  expect(inline.rows.find((row) => row.kind === 'group')).toBeUndefined();
  expect(inline.rows.filter((row): row is RosterAgentRow => row.kind === 'agent').map((row) => row.node.agentId)).toEqual(['live', 'unknown-0', 'unknown-1', 'unknown-2']);
  const filtered = buildRoster({ ...base, forest: registered, waiting: new Set(), filter: 'unknown' });
  expect(filtered.rows.filter((row) => row.kind === 'agent')).toHaveLength(4);
  expect(filtered.counts.idle).toBe(1);
  expect(filtered.rows.every((row) => row.kind === 'agent' && row.bucket === 'unknown')).toBe(true);
});

it('keeps an unknown parent with live or waiting descendants out of the historical unknown group', () => {
  const registered = buildAgentForest([], [
    { agentId: 'main' },
    { agentId: 'parent', parentAgentId: 'main', status: 'unknown' as const },
    { agentId: 'child', parentAgentId: 'parent', status: 'running' as const },
    { agentId: 'needs', parentAgentId: 'main', status: 'unknown' as const },
    { agentId: 'ask', parentAgentId: 'needs', status: 'suspended' as const },
    ...Array.from({ length: 4 }, (_, index) => ({ agentId: `old-${index}`, parentAgentId: 'main', status: 'unknown' as const })),
  ]);
  const model = buildRoster({ ...base, forest: registered, waiting: new Set() });
  expect(model.rows[0]).toMatchObject({ kind: 'agent', node: { agentId: 'needs' }, bucket: 'unknown', childCount: 1 });
  expect(model.rows[1]).toMatchObject({ kind: 'agent', node: { agentId: 'parent' }, bucket: 'unknown', childCount: 1 });
  expect(model.rows.filter((row) => row.kind === 'group')).toEqual([
    { kind: 'group', bucket: 'unknown', count: 4, open: false },
  ]);
  expect(model.rows.some((row) => row.kind === 'agent' && row.node.agentId.startsWith('old-'))).toBe(false);
  const opened = buildRoster({ ...base, forest: registered, waiting: new Set(), unknownOpen: true, expanded: new Set(['parent', 'needs']) });
  const ids = opened.rows.filter((row): row is RosterAgentRow => row.kind === 'agent').map((row) => row.node.agentId);
  expect(ids).toEqual(['needs', 'ask', 'parent', 'child', 'old-0', 'old-1', 'old-2', 'old-3']);
  expect(model.counts).toEqual({ waiting: 1, running: 1, idle: 0, unknown: 6, ended: 0 });
});
