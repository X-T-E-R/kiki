import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode } from '@kiki/session-core/session';
import { fleetUnder, laneWindow, type FleetState } from './model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-03T12:34:56.789Z');

function node(agentId: string, overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    agentId, name: agentId, label: agentId, status: 'running', busy: true,
    toolCallCount: 0, childIds: [], ...overrides,
  };
}

function forestOf(nodes: readonly AgentTreeNode[]): AgentForest {
  return { roots: nodes, byId: Object.fromEntries(nodes.map((entry) => [entry.agentId, entry])) };
}

describe('fleetUnder', () => {
  it('projects labels, descriptions, both timestamps and depth relative to the viewed agent', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['child', 'sibling'] }),
      node('child', {
        label: 'Research', description: 'Check the evidence', childIds: ['grandchild'],
        startedAt: '2026-10-03T10:00:00Z', endedAt: '2026-10-03T11:00:00Z', status: 'completed',
      }),
      node('grandchild', { childIds: ['leaf'] }),
      node('leaf'),
      node('sibling'),
    ]);

    expect(fleetUnder(forest, MAIN_AGENT_ID, new Set())).toEqual([
      {
        id: 'child', label: 'Research', description: 'Check the evidence', state: 'done', needsUser: false,
        depth: 0, startedAt: Date.parse('2026-10-03T10:00:00Z'), endedAt: Date.parse('2026-10-03T11:00:00Z'),
      },
      { id: 'grandchild', label: 'grandchild', description: undefined, state: 'running', needsUser: false, depth: 1, startedAt: undefined, endedAt: undefined },
      { id: 'leaf', label: 'leaf', description: undefined, state: 'running', needsUser: false, depth: 2, startedAt: undefined, endedAt: undefined },
      { id: 'sibling', label: 'sibling', description: undefined, state: 'running', needsUser: false, depth: 0, startedAt: undefined, endedAt: undefined },
    ]);
    expect(fleetUnder(forest, 'child', new Set()).map(({ id, depth }) => ({ id, depth }))).toEqual([
      { id: 'grandchild', depth: 0 }, { id: 'leaf', depth: 1 },
    ]);
  });

  it('preserves all status mappings and separates user waits from dependency suspension', () => {
    // 'unknown' stays unknown: a status the session never reported is not a
    // finished agent, and mapping it onto 'done' is what let a partial read
    // look like a completed session.
    const mappings: readonly [AgentTreeNode['status'], FleetState][] = [
      ['unknown', 'unknown'], ['running', 'running'], ['suspended', 'waiting'], ['completed', 'done'],
      ['failed', 'failed'], ['cancelled', 'stopped'], ['background', 'running'],
    ];
    const ids = mappings.map(([status]) => status);
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ids }),
      ...mappings.map(([status]) => node(status, { status })),
    ]);

    expect(fleetUnder(forest, MAIN_AGENT_ID, new Set()).map(({ id, state, needsUser }) => ({ id, state, needsUser }))).toEqual(
      mappings.map(([id, state]) => ({ id, state, needsUser: false })),
    );
    const waitingIds = new Set(['running', 'suspended', 'failed', 'not-in-forest']);
    expect(fleetUnder(forest, MAIN_AGENT_ID, waitingIds).map(({ id, state, needsUser }) => ({ id, state, needsUser }))).toEqual(
      mappings.map(([id, state]) => ({ id, state: waitingIds.has(id) ? 'waiting' : state, needsUser: waitingIds.has(id) })),
    );
  });

  it('keeps absent, empty and invalid timestamps unknown', () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['absent', 'empty', 'invalid'] }),
      node('absent'),
      node('empty', { startedAt: '', endedAt: '' }),
      node('invalid', { startedAt: 'not-a-date', endedAt: 'not-a-date' }),
    ]);
    expect(fleetUnder(forest, MAIN_AGENT_ID, new Set()).map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))).toEqual([
      { startedAt: undefined, endedAt: undefined },
      { startedAt: undefined, endedAt: undefined },
      { startedAt: undefined, endedAt: undefined },
    ]);
  });
});

describe('laneWindow', () => {
  it('returns a 15-minute window ending at now for empty input', () => {
    expect(laneWindow({ starts: [undefined], markers: [], now: NOW })).toEqual({
      start: NOW - 15 * MINUTE, end: NOW,
      ticks: [NOW - 15 * MINUTE, NOW - 10 * MINUTE, NOW - 5 * MINUTE, NOW],
    });
    expect(laneWindow({ starts: [], markers: [], now: NOW })).toEqual(
      laneWindow({ starts: [undefined], markers: [], now: NOW }),
    );
  });

  it('extends short histories to 15 minutes', () => {
    const window = laneWindow({ starts: [NOW - 2 * MINUTE], markers: [NOW - 7 * MINUTE], now: NOW });
    expect(window.start).toBe(NOW - 15 * MINUTE);
    expect(window.end).toBe(NOW);
    expect(window.ticks).toEqual([NOW - 15 * MINUTE, NOW - 10 * MINUTE, NOW - 5 * MINUTE, NOW]);
  });

  it('covers the oldest start or marker without rounding start, and anchors hourly ticks at now', () => {
    const oldest = NOW - 3 * HOUR - 19_000;
    const window = laneWindow({ starts: [undefined, NOW - HOUR, NOW - 2 * HOUR], markers: [oldest, NOW - MINUTE], now: NOW });
    expect(window).toEqual({
      start: oldest, end: NOW, ticks: [NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR, NOW],
    });
    expect(laneWindow({ starts: [oldest], markers: [NOW - MINUTE], now: NOW }).start).toBe(oldest);
  });

  it.each([
    { span: 30 * MINUTE, step: 15 * MINUTE },
    { span: 5 * HOUR, step: HOUR },
    { span: 4 * DAY, step: DAY },
    { span: 10 * DAY, step: 2 * DAY },
    { span: 40 * DAY, step: 14 * DAY },
    { span: 365 * DAY, step: 90 * DAY },
    { span: 451 * DAY, step: 365 * DAY },
    { span: 2_201 * DAY, step: 441 * DAY },
  ])('chooses the smallest step at least one fifth of a $span ms history', ({ span, step }) => {
    const window = laneWindow({ starts: [NOW - span], markers: [], now: NOW });
    expect(window.start).toBe(NOW - span);
    expect(window.end).toBe(NOW);
    expect(window.ticks).toEqual(Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => NOW - (Math.floor(span / step) - i) * step));
  });

  it('keeps ticks strictly ascending, inside the window, ending at now and bounded to 2–6 across step boundaries', () => {
    const steps = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY];
    const spans = [0, 3 * MINUTE, ...steps.flatMap((step) => [5 * step - 1, 5 * step, 5 * step + 1]), 10_000 * DAY];
    for (const span of spans) {
      const oldest = NOW - span;
      const window = laneWindow({ starts: [undefined, oldest], markers: [NOW - MINUTE], now: NOW });
      expect(window.start).toBeLessThanOrEqual(oldest);
      expect(window.start).toBeLessThanOrEqual(NOW - 15 * MINUTE);
      expect(window.end).toBe(NOW);
      expect(window.ticks.length).toBeGreaterThanOrEqual(2);
      expect(window.ticks.length).toBeLessThanOrEqual(6);
      expect(window.ticks.at(-1)).toBe(NOW);
      for (const [i, tick] of window.ticks.entries()) {
        expect(tick).toBeGreaterThanOrEqual(window.start);
        expect(tick).toBeLessThanOrEqual(window.end);
        if (i > 0) expect(tick).toBeGreaterThan(window.ticks[i - 1]!);
      }
    }
  });
});
