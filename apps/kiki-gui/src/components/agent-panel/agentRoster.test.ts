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
    expect(model.counts).toEqual({ waiting: 1, running: 2, failed: 1, done: 5 });
    expect(model.total).toBe(9);
    // Lead finished, but its grandchild waits on the user: it leads the list.
    expect(labels(model.rows)).toEqual(['Lead', 'Live', 'Broken', '[4 done]']);
    const lead = model.rows[0] as RosterAgentRow;
    expect(lead.expanded).toBe(false);
    expect(lead.childCount).toBe(1);
    expect(lead.waitingBelow).toBe(1);
  });

  it('opens branches on demand and the completed group on demand', () => {
    const model = buildRoster({ ...base, expanded: new Set(['lead', 'worker']), doneOpen: true });
    expect(labels(model.rows)).toEqual(['Lead', 'Worker', 'Probe', 'Live', 'Broken', '[4 done]', 'Done A', 'Done B', 'Done C', 'Done D']);
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
