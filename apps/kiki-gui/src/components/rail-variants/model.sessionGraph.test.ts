/**
 * The graph's own claims, tested against the cases that decide whether the
 * cockpit is honest: a whole session that does not read as finished, a reader's
 * wait that is not an agent's age, and states that never collapse into each
 * other.
 */

import { describe, expect, it } from 'vitest';

import type { ApprovalBlock, AgentForest, AgentTreeNode, QuestionBlock } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { axisTicks, sessionGraph, waitingSince } from './model';

const MINUTE = 60_000;

function node(agentId: string, overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    agentId, name: agentId, label: agentId, status: 'completed', busy: false,
    toolCallCount: 0, childIds: [], ...overrides,
  };
}

function forestOf(nodes: readonly AgentTreeNode[]): AgentForest {
  return { roots: [nodes[0]!], byId: Object.fromEntries(nodes.map((entry) => [entry.agentId, entry])) };
}

function approval(originAgentId: string, createdAt: string): ApprovalBlock {
  return {
    kind: 'approval',
    id: `a-${originAgentId}`,
    resolution: undefined,
    originAgentId,
    request: {
      approval_id: `a-${originAgentId}`,
      session_id: 's',
      tool_call_id: 'c',
      tool_name: 'Bash',
      action: 'Run: git diff',
      tool_input_display: { kind: 'command', command: 'git diff' },
      created_at: createdAt,
      expires_at: createdAt,
    },
  } as ApprovalBlock;
}

function question(originAgentId: string, createdAt: string): QuestionBlock {
  return {
    kind: 'question',
    id: `q-${originAgentId}`,
    outcome: undefined,
    originAgentId,
    request: {
      question_id: `q-${originAgentId}`,
      session_id: 's',
      turn_id: 1,
      tool_call_id: 'c',
      questions: [{ id: 'q1', question: 'Which files?', options: [{ id: 'o1', label: 'src' }] }],
      created_at: createdAt,
    },
  } as QuestionBlock;
}

describe('sessionGraph', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');

  it('reads the whole session from the root whatever agent is selected', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['a', 'b'] }),
      node('a', { label: 'Docs lead', childIds: ['a1'] }),
      node('a1', { label: 'Docs worker' }),
      node('b', { label: 'API lead' }),
    ]);
    const graph = sessionGraph({
      forest,
      pending: [],
      mainState: { busy: true, turnStartedAt: now - 40 * MINUTE },
      expanded: new Set(),
      mainLabel: 'Main agent',
    });
    // Two branches, not the one selected agent's subtree: the graph never
    // rescopes itself to the current selection.
    expect(graph.rows.map((row) => [row.kind, row.id])).toEqual([
      ['main', MAIN_AGENT_ID],
      ['branch', 'a'],
      ['branch', 'b'],
    ]);
    expect(graph.agentCount).toBe(4);
  });

  it('expands a branch in place, revealing that branch only', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['a', 'b'] }),
      node('a', { label: 'Docs lead', parentAgentId: MAIN_AGENT_ID, childIds: ['a1', 'a2'] }),
      node('a1', { label: 'Docs worker 1', parentAgentId: 'a' }),
      node('a2', { label: 'Docs worker 2', parentAgentId: 'a' }),
      node('b', { label: 'API lead', parentAgentId: MAIN_AGENT_ID }),
    ]);
    const graph = sessionGraph({
      forest,
      pending: [],
      mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(['a']),
      mainLabel: 'Main agent',
    });
    expect(graph.rows.map((row) => row.kind === 'agent' ? [row.kind, row.id, row.depth] : [row.kind, row.id])).toEqual([
      ['main', MAIN_AGENT_ID],
      ['agent', 'a', 1],
      ['agent', 'a1', 2],
      ['agent', 'a2', 2],
      ['branch', 'b'],
    ]);
  });

  it('does not call the session finished when a parent ended but its grandchild waits', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['lead'] }),
      node('lead', { label: 'API lead', status: 'completed', childIds: ['worker'] }),
      node('worker', { label: 'API worker 2', status: 'suspended' }),
    ]);
    const pending = [approval('worker', '2026-10-05T11:57:00Z')];
    const graph = sessionGraph({
      forest,
      pending,
      mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(['lead']),
      mainLabel: 'Main agent',
    });
    // The lead is genuinely completed; the session is not.
    const byId = Object.fromEntries(graph.rows.map((row) => [row.id, row]));
    expect(byId['lead']?.kind === 'agent' && byId['lead'].state).toBe('done');
    expect(byId['worker']?.kind === 'agent' && byId['worker'].state).toBe('waiting');
    expect(byId['worker']?.kind === 'agent' && byId['worker'].needsUser).toBe(true);
    const waiting = graph.composition.find((entry) => entry.state === 'waiting');
    expect(waiting).toEqual({ state: 'waiting', count: 1, needsUser: true });
    expect(graph.composition.reduce((sum, entry) => sum + entry.count, 0)).toBe(graph.agentCount);
  });

  it('keeps an unreported state out of the finished count', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['a', 'b', 'c'] }),
      node('a', { status: 'completed' }),
      node('b', { status: 'unknown' }),
      node('c', { status: 'completed' }),
    ]);
    const graph = sessionGraph({
      forest, pending: [], mainState: { busy: true, turnStartedAt: now - MINUTE },
      expanded: new Set(['a', 'b', 'c']), mainLabel: 'Main agent',
    });
    const done = graph.composition.find((entry) => entry.state === 'done');
    const unknown = graph.composition.find((entry) => entry.state === 'unknown');
    // Two agents reported completed. The unreported one is counted as such.
    expect(done?.count).toBe(2);
    expect(unknown?.count).toBe(1);
  });

  it('does not count a wait as running, and does not count a suspension as a user wait', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['mine', 'theirs'] }),
      node('mine', { status: 'suspended' }),
      node('theirs', { status: 'suspended' }),
    ]);
    const graph = sessionGraph({
      forest,
      pending: [approval('mine', '2026-10-05T11:59:00Z')],
      mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(['mine', 'theirs']),
      mainLabel: 'Main agent',
    });
    const running = graph.composition.filter((entry) => entry.state === 'running');
    expect(running).toEqual([]);
    const waiting = graph.composition.filter((entry) => entry.state === 'waiting');
    expect(waiting).toEqual([
      { state: 'waiting', count: 1, needsUser: true },
      { state: 'waiting', count: 1, needsUser: false },
    ]);
  });

  it('takes the wait from the request, not from when the agent started', () => {
    const longRun = '2026-10-05T11:31:00Z'; // 29 minutes ago
    const requestAt = '2026-10-05T11:57:00Z'; // 3 minutes ago
    expect(waitingSince([approval('w', requestAt)], 'w')).toBe(Date.parse(requestAt));
    // The agent's own start is 26 minutes earlier and must not be used.
    expect(Date.parse(requestAt) - Date.parse(longRun)).toBe(26 * MINUTE);
    expect(waitingSince([], 'w')).toBeUndefined();
    expect(waitingSince([question('other', requestAt)], 'w')).toBeUndefined();
  });

  it('takes the earliest of several requests from the same agent', () => {
    const graph2 = sessionGraph({
      forest: forestOf([node(MAIN_AGENT_ID, { childIds: ['w'] }), node('w')]),
      pending: [approval('w', '2026-10-05T11:58:00Z'), question('w', '2026-10-05T11:40:00Z')],
      mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(['w']),
      mainLabel: 'Main agent',
    });
    const row = graph2.rows.find((entry) => entry.id === 'w');
    expect(row?.kind === 'agent' && row.waitingSince).toBe(Date.parse('2026-10-05T11:40:00Z'));
  });

  it('leaves a group with no recorded time blank rather than drawing a zero-length run', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['a'] }),
      node('a', { label: 'Docs lead' }),
    ]);
    const graph = sessionGraph({
      forest, pending: [], mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(), mainLabel: 'Main agent',
    });
    const branch = graph.rows.find((row) => row.kind === 'branch');
    expect(branch?.kind === 'branch' && branch.from).toBeUndefined();
    expect(branch?.kind === 'branch' && branch.to).toBeUndefined();
    expect(graph.from).toBeUndefined();
  });

  it('spans a session that crosses days without inventing intermediate activity', () => {
    const threeDays = 3 * 24 * 60 * MINUTE;
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['a', 'b'] }),
      node('a', { startedAt: new Date(now - threeDays).toISOString(), endedAt: new Date(now - threeDays + 20 * MINUTE).toISOString() }),
      node('b', { startedAt: new Date(now - 30 * MINUTE).toISOString() }),
    ]);
    const graph = sessionGraph({
      forest, pending: [], mainState: { busy: true, turnStartedAt: now - 10 * MINUTE },
      expanded: new Set(), mainLabel: 'Main agent',
    });
    expect(graph.from).toBe(now - threeDays);
    const a = graph.rows.find((row) => row.id === 'a');
    const b = graph.rows.find((row) => row.id === 'b');
    // Each group states the period it has records for. The three-day group
    // ends where its records end, not where the session ends.
    expect(a?.kind === 'branch' && [a.from, a.to]).toEqual([now - threeDays, now - threeDays + 20 * MINUTE]);
    expect(b?.kind === 'branch' && b.to).toBe(now - 30 * MINUTE);
  });

  it('carries a background-free session without inventing an empty running table', () => {
    const graph = sessionGraph({
      forest: forestOf([node(MAIN_AGENT_ID)]),
      pending: [],
      mainState: { busy: false, turnStartedAt: undefined },
      expanded: new Set(),
      mainLabel: 'Main agent',
    });
    expect(graph.rows).toHaveLength(1);
    expect(graph.agentCount).toBe(1);
    expect(graph.composition).toEqual([{ state: 'done', count: 1, needsUser: false }]);
  });
});

describe('axisTicks', () => {
  const pct = (at: number) => ((at - 0) / 100) * 100;

  it('keeps every tick when the axis is wide enough for them', () => {
    const ticks = [0, 25, 50, 75, 100];
    expect(axisTicks(ticks, pct, 400, 52).map((entry) => entry.tick)).toEqual(ticks);
  });

  it('always keeps the window start and now, however narrow the axis', () => {
    const ticks = [0, 20, 40, 60, 80, 100];
    const shown = axisTicks(ticks, pct, 120, 52).map((entry) => entry.tick);
    expect(shown[0]).toBe(0);
    expect(shown.at(-1)).toBe(100);
    expect(shown.at(-1) === 100 ? axisTicks(ticks, pct, 120, 52).at(-1)?.last : false).toBe(true);
  });

  it('thins against the last printed tick, not the immediate neighbour', () => {
    // Ticks 50 and 75 sit 25% apart = 10px at a 40px axis: both must go,
    // even though each is only 10px from its own neighbour.
    const shown = axisTicks([0, 10, 20, 30, 50, 75, 100], pct, 40, 52).map((entry) => entry.tick);
    expect(shown).toEqual([0, 100]);
  });

  it('keeps a tick once enough room has accumulated since the last printed one', () => {
    const shown = axisTicks([0, 25, 60, 100], pct, 400, 52).map((entry) => entry.tick);
    expect(shown).toEqual([0, 25, 60, 100]);
  });

  it('returns nothing for an empty tick list', () => {
    expect(axisTicks([], pct, 400, 52)).toEqual([]);
  });
});
