/**
 * Session background work: whose task it is, and how much of the tree these
 * rows can speak for.
 *
 * The contract under test is the one the cockpit depends on. Pretending main's
 * task list is the session's would make a subagent's shell job invisible;
 * pretending the rows are complete would make a missing agent look idle.
 */

import { describe, expect, it } from 'vitest';

import type { Task } from '@kiki/protocol';
import type { AgentForest, AgentTreeNode } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { backgroundRowsOf, isDispatchTask, projectSessionTasks, taskRowState, treeOrder } from './sessionTasks';

function node(agentId: string, overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    agentId, name: agentId, label: agentId, status: 'completed', busy: false,
    toolCallCount: 0, childIds: [], ...overrides,
  };
}

function forestOf(nodes: readonly AgentTreeNode[]): AgentForest {
  return { roots: [nodes[0]!], byId: Object.fromEntries(nodes.map((entry) => [entry.agentId, entry])) };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    session_id: 's',
    kind: 'bash',
    description: `run ${id}`,
    status: 'running',
    created_at: '2026-10-05T11:00:00Z',
    started_at: '2026-10-05T11:00:00Z',
    ...overrides,
  } as Task;
}

const FLEET = forestOf([
  node(MAIN_AGENT_ID, { childIds: ['lead', 'other'] }),
  node('lead', { childIds: ['worker'] }),
  node('worker'),
  node('other'),
]);

describe('treeOrder', () => {
  it('lists the tree depth-first in dispatch order, main first', () => {
    expect(treeOrder(FLEET)).toEqual([MAIN_AGENT_ID, 'lead', 'worker', 'other']);
  });

  it('does not loop on a malformed forest and still reaches an orphan', () => {
    const looped: AgentForest = {
      roots: [node(MAIN_AGENT_ID, { childIds: ['a'] })],
      byId: {
        [MAIN_AGENT_ID]: node(MAIN_AGENT_ID, { childIds: ['a'] }),
        a: node('a', { parentAgentId: MAIN_AGENT_ID, childIds: [MAIN_AGENT_ID] }),
        orphan: node('orphan'),
      },
    };
    expect(treeOrder(looped)).toEqual([MAIN_AGENT_ID, 'a', 'orphan']);
  });
});

describe('projectSessionTasks', () => {
  it('attributes a task to the agent whose collection it came from, not to the agent it spawned', () => {
    const dispatch = task('t1', { kind: 'subagent', agent_id: 'worker', status: 'running' });
    const shell = task('t2', { kind: 'bash', status: 'running' });
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [dispatch], lead: [shell] },
    });
    // The dispatch row is main's work; the shell job is the lead's.
    expect(projection.rows.map((row) => [row.task.id, row.ownerAgentId])).toEqual([
      ['t1', MAIN_AGENT_ID],
      ['t2', 'lead'],
    ]);
    // And a dispatch is not a second copy of the agent row.
    expect(backgroundRowsOf(projection.rows).map((row) => row.task.id)).toEqual(['t2']);
    expect(isDispatchTask(dispatch)).toBe(true);
  });

  it('does not stand in the loaded forest for the session agent count', () => {
    // The forest is a page of the session's agents, not the session's agents.
    // Using its size as the denominator would report full coverage for a
    // partially-loaded session, so without a server count the total is simply
    // not established.
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')], lead: [task('t2')] },
    });
    expect(projection.coverage.covered).toBe(2);
    expect(projection.coverage.total).toBeUndefined();
    expect(projection.coverage.totalKnown).toBe(false);
    // Not "partial" either: there is no known total to be short of.
    expect(projection.coverage.partial).toBe(false);
  });

  it('uses the session agent inventory as the denominator, on the read own owner footing', () => {
    // The inventory counts every dispatched agent and the task read's owner
    // set is `new Set(['main', ...live])`, so the two agree on what an owner is
    // and the inventory is used as-is. Adjusting it here would put the two
    // sources a whole agent apart.
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')], lead: [task('t2')] },
      agentTotal: 41,
    });
    expect(projection.coverage).toMatchObject({ covered: 2, total: 41, totalKnown: true, partial: true });
  });

  it('reads a main-only session as one owner of one, not zero of zero', () => {
    // The counter-example for subtracting main: a session with only main and no
    // subagents has exactly one possible task owner, and its inventory says 1.
    // Reading that as "0 of 0" would report an empty read of an empty session,
    // which is the opposite of what the server said.
    const mainOnly = forestOf([node(MAIN_AGENT_ID)]);
    const projection = projectSessionTasks({
      forest: mainOnly,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')] },
      agentTotal: 1,
    });
    expect(projection.coverage).toMatchObject({ covered: 1, total: 1, totalKnown: true, partial: false });
  });

  it('reads a main-only session with no tasks as one owner of one, complete', () => {
    // Same shape, nothing running: still a completed read of one owner, not a
    // gap and not a zero.
    const mainOnly = forestOf([node(MAIN_AGENT_ID)]);
    const projection = projectSessionTasks({ forest: mainOnly, ownerStates: { [MAIN_AGENT_ID]: [] }, agentTotal: 1 });
    expect(projection.coverage).toMatchObject({ covered: 1, total: 1, totalKnown: true, partial: false, windowed: false });
    expect(projection.rows).toEqual([]);
  });

  it('keeps the same footing between the read count and the inventory count', () => {
    // A session of 300 agents, two of which have been read: whichever source
    // supplies the denominator, the fraction is out of 300, never 299 and
    // never the 2 that happen to be resident.
    const asInventory = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')] },
      agentTotal: 300,
    });
    const asRead = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')] },
      summary: { rows: [], agentsReported: 2, agentsTotal: 300, inventoryIncomplete: false, readFailed: false, hasMore: false },
      agentTotal: 300,
    });
    expect(asInventory.coverage).toMatchObject({ covered: 1, total: 300, totalKnown: true, partial: true });
    expect(asRead.coverage).toMatchObject({ covered: 2, total: 300, totalKnown: true, partial: true });
  });

  it('does not let a zero inventory become a negative owner count', () => {
    const projection = projectSessionTasks({ forest: FLEET, ownerStates: {}, agentTotal: 0 });
    expect(projection.coverage.total).toBe(0);
    expect(projection.coverage.totalKnown).toBe(true);
  });

  it('marks a windowed collection, where even the covered agents are incomplete', () => {
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [task('t1')] },
      coverage: { [MAIN_AGENT_ID]: { returned: 1, total: 40, hasMore: true } },
      agentTotal: 3,
    });
    expect(projection.coverage.windowed).toBe(true);
    expect(projection.coverage.partial).toBe(true);
  });

  it('counts a fully covered tree as complete', () => {
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [], lead: [], worker: [], other: [] },
      // Four owners and no others: the inventory counts main among the
      // dispatched agents, so a session of exactly these four is `total: 4`.
      agentTotal: 4,
    });
    expect(projection.coverage).toEqual({ covered: 4, total: 4, totalKnown: true, partial: false, windowed: false });
    // An agent with an empty collection is still covered: nothing running is
    // a fact about it, unlike an agent nobody has read.
    expect(projection.rows).toEqual([]);
  });

  it('reports a shortfall against the inventory when agents were never loaded', () => {
    // Four owners are represented but the session dispatched five, so this is
    // a known shortfall against a known total — not an unknown one.
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [], lead: [], worker: [], other: [] },
      agentTotal: 5,
    });
    expect(projection.coverage).toEqual({ covered: 4, total: 5, totalKnown: true, partial: true, windowed: false });
  });

  it('counts one task once when two collections report the same row', () => {
    const shared = task('t1');
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: { [MAIN_AGENT_ID]: [shared], lead: [shared] },
    });
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]?.ownerAgentId).toBe(MAIN_AGENT_ID);
  });

  it('orders rows by the tree, then by start, and keeps unparsable times unknown', () => {
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: {
        other: [task('late', { started_at: '2026-10-05T11:30:00Z' })],
        lead: [task('broken', { started_at: 'not-a-date', created_at: 'also-not' })],
        [MAIN_AGENT_ID]: [task('early', { started_at: '2026-10-05T10:00:00Z' })],
      },
    });
    expect(projection.rows.map((row) => row.task.id)).toEqual(['early', 'broken', 'late']);
    expect(projection.rows[1]?.startedAt).toBeUndefined();
  });

  it('reads a finished task end and leaves a running one open', () => {
    const projection = projectSessionTasks({
      forest: FLEET,
      ownerStates: {
        [MAIN_AGENT_ID]: [
          task('done', { status: 'completed', completed_at: '2026-10-05T11:05:00Z' }),
          task('going', { status: 'running' }),
        ],
      },
    });
    expect(projection.rows.map((row) => [row.task.id, row.endedAt])).toEqual([
      ['done', Date.parse('2026-10-05T11:05:00Z')],
      ['going', undefined],
    ]);
  });
});

describe('taskRowState', () => {
  it('maps every protocol status without folding unknown outcomes into done', () => {
    const state = (status: Task['status']) => taskRowState({
      task: task('t', { status }),
      ownerAgentId: MAIN_AGENT_ID,
      startedAt: undefined,
      endedAt: undefined,
      ownerUnknown: false,
    });
    expect(state('running')).toBe('running');
    expect(state('completed')).toBe('done');
    expect(state('failed')).toBe('failed');
    expect(state('cancelled')).toBe('stopped');
  });
});

describe('projectSessionTasks with a whole-tree summary', () => {
  const tree = forestOf([
    node(MAIN_AGENT_ID, { childIds: ['lead', 'other'] }),
    node('lead', { childIds: ['worker'] }),
    node('worker'),
    node('other'),
  ]);

  it('shows an unopened agent own background work without that agent being visited', () => {
    // Only the root has been opened, so the controller holds one collection.
    // The summary knows about a grandchild nobody has opened.
    const projection = projectSessionTasks({
      forest: tree,
      ownerStates: { [MAIN_AGENT_ID]: [task('t-main', { kind: 'bash' })] },
      summary: {
        rows: [
          { task: task('t-main', { kind: 'bash' }), ownerAgentId: MAIN_AGENT_ID },
          { task: task('t-worker', { kind: 'bash' }), ownerAgentId: 'worker' },
        ],
        agentsReported: 4,
        agentsTotal: 4,
        inventoryIncomplete: false,
        readFailed: false,
        hasMore: false,
      },
    });
    // The grandchild's shell job is visible, and attributed to its real owner.
    const grandchild = projection.rows.find((row) => row.task.id === 't-worker');
    expect(grandchild?.ownerAgentId).toBe('worker');
    // Coverage is the tree's, not the visited subset's.
    expect(projection.coverage).toEqual({ covered: 4, total: 4, totalKnown: true, partial: false, windowed: false });
  });

  it('uses the summary as the base and does not let resident rows mask its gaps', () => {
    const projection = projectSessionTasks({
      forest: tree,
      // A live row the controller holds that the summary's page does not carry.
      ownerStates: { [MAIN_AGENT_ID]: [task('t-live', { kind: 'bash' })] },
      summary: {
        rows: [{ task: task('t-page', { kind: 'bash' }), ownerAgentId: 'lead' }],
        agentsReported: 4,
        agentsTotal: 4,
        inventoryIncomplete: false,
        readFailed: false,
        hasMore: false,
      },
    });
    // The summary is the whole-tree authority. Its coverage is reported as it
    // arrived, and the resident collection does not quietly widen that claim:
    // merging would hide a page the server has not sent yet.
    expect(projection.rows.map((row) => row.task.id)).toEqual(['t-page']);
    expect(projection.coverage).toEqual({ covered: 4, total: 4, totalKnown: true, partial: false, windowed: false });
  });

  it('does not count a row twice when both sources carry it', () => {
    const shared = projectSessionTasks({
      forest: tree,
      ownerStates: { lead: [task('t-page')] },
      summary: {
        rows: [{ task: task('t-page'), ownerAgentId: 'lead' }],
        agentsReported: 4, agentsTotal: 4, inventoryIncomplete: false, readFailed: false, hasMore: false,
      },
    });
    expect(shared.rows).toHaveLength(1);
  });

  it('marks an incomplete-inventory or paged summary as not complete', () => {
    // A server that could not enumerate every owner means its own denominator
    // is a subset, so the read is windowed: it is not a read limit, and the
    // two must not be folded into one flag.
    const capped = projectSessionTasks({
      forest: tree,
      summary: { rows: [], agentsReported: 1, agentsTotal: 4, inventoryIncomplete: true, readFailed: false, hasMore: false },
    });
    expect(capped.coverage).toEqual({ covered: 1, total: 4, totalKnown: true, partial: true, windowed: true });
    const paged = projectSessionTasks({
      forest: tree,
      summary: { rows: [], agentsReported: 4, agentsTotal: 4, inventoryIncomplete: false, readFailed: false, hasMore: true },
    });
    expect(paged.coverage.windowed).toBe(true);
    // A failed owner read is missing work, not a window: it does not make the
    // page "not all of it has arrived yet", and the coverage arithmetic is
    // unchanged, so only the flag distinguishes it.
    const failed = projectSessionTasks({
      forest: tree,
      summary: { rows: [], agentsReported: 4, agentsTotal: 4, inventoryIncomplete: false, readFailed: true, hasMore: false },
    });
    expect(failed.coverage).toEqual({ covered: 4, total: 4, totalKnown: true, partial: false, windowed: false });
  });

  it('keeps a row whose owner the server could not name, rather than dropping it', () => {
    const projection = projectSessionTasks({
      forest: tree,
      summary: {
        rows: [{ task: task('t-orphan', { kind: 'bash' }), ownerAgentId: MAIN_AGENT_ID, ownerUnknown: true }],
        agentsReported: 4, agentsTotal: 4, inventoryIncomplete: false, readFailed: false, hasMore: false,
      },
    });
    const row = projection.rows[0]!;
    expect(row.ownerUnknown).toBe(true);
    expect(row.ownerAgentId).toBe(MAIN_AGENT_ID);
  });

  it('falls back to resident collections only while no summary has arrived', () => {
    const projection = projectSessionTasks({
      forest: tree,
      ownerStates: { [MAIN_AGENT_ID]: [task('t-main')] },
      summary: undefined,
    });
    expect(projection.rows.map((row) => row.task.id)).toEqual(['t-main']);
    // The rows are real but they are the visited subset, and without a server
    // count there is no total to be a fraction of — so the coverage says the
    // one thing it knows ("one owner represented") and no more.
    expect(projection.coverage).toEqual({ covered: 1, total: undefined, totalKnown: false, partial: false, windowed: false });
  });

  it('prefers the summary own count over the session inventory', () => {
    // Both are server counts; the read's own is about the owners it
    // inventoried, which is what this coverage is a fraction of.
    const projection = projectSessionTasks({
      forest: tree,
      summary: { rows: [], agentsReported: 2, agentsTotal: 9, inventoryIncomplete: false, readFailed: false, hasMore: false },
      agentTotal: 100,
    });
    expect(projection.coverage.total).toBe(9);
  });
});
