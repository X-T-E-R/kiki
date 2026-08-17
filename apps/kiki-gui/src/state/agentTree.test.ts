import { describe, expect, it } from 'vitest';

import {
  advanceAgentHistoryCursor,
  agentChildren,
  agentPath,
  agentSiblings,
  buildAgentForest,
  compareAgentIds,
  applyNewestAgentPage,
  mergeAgentTranscript,
  prependOlderAgentPage,
  resetAgentHistoryCache,
  stabilizeAgentForest,
  type AgentLiveSource,
  type AgentRosterDescriptor,
  type AgentTaskItem,
  type AgentTimelineBlock,
  type AgentTranscriptPage,
} from './agentTree';

function live(overrides: Partial<AgentLiveSource> & Pick<AgentLiveSource, 'subagentId'>): AgentLiveSource {
  return {
    name: overrides.name ?? overrides.subagentId,
    status: 'running',
    ...overrides,
  };
}

function roster(
  overrides: Partial<AgentRosterDescriptor> & Pick<AgentRosterDescriptor, 'agentId'>,
): AgentRosterDescriptor {
  return {
    name: overrides.name ?? overrides.agentId,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTaskItem> & { agentId?: string; id?: string }): AgentTaskItem {
  return {
    kind: 'subagent',
    status: 'completed',
    ...overrides,
  };
}

function block(
  overrides: Partial<AgentTimelineBlock> & Pick<AgentTimelineBlock, 'id'>,
): AgentTimelineBlock {
  return {
    kind: overrides.kind ?? 'assistant',
    ...overrides,
  };
}

function page(
  blocks: readonly AgentTimelineBlock[],
  overrides: Partial<AgentTranscriptPage> = {},
): AgentTranscriptPage {
  return {
    blocks,
    hasMore: false,
    ...overrides,
  };
}

function snapshotJson<T>(value: T): string {
  return JSON.stringify(value);
}

describe('compareAgentIds', () => {
  it('puts main first and sorts agent-N numerically', () => {
    expect(['agent-10', 'main', 'agent-2'].sort(compareAgentIds)).toEqual([
      'main',
      'agent-2',
      'agent-10',
    ]);
  });

  it('orders non-agent ids by code units, not the runtime locale', () => {
    expect(['ö', 'z', 'Z'].sort(compareAgentIds)).toEqual(['Z', 'z', 'ö']);
  });
});

describe('buildAgentForest', () => {
  it('builds a main → child → grandchild tree with path and siblings', () => {
    const forest = buildAgentForest(
      [
        live({ subagentId: 'agent-1', name: 'Child', parentToolCallId: 'call-1', status: 'running' }),
        live({
          subagentId: 'agent-2',
          name: 'Grandchild',
          parentToolCallId: 'call-2',
          status: 'completed',
          summary: 'done',
        }),
      ],
      [
        roster({ agentId: 'main', name: 'Main' }),
        roster({ agentId: 'agent-1', parentAgentId: 'main', name: 'Child' }),
        roster({ agentId: 'agent-2', parentAgentId: 'agent-1', name: 'Grandchild' }),
      ],
    );

    expect(forest.roots.map((node) => node.agentId)).toEqual(['main']);
    expect(forest.byId['main']!.childIds).toEqual(['agent-1']);
    expect(forest.byId['agent-1']!.childIds).toEqual(['agent-2']);
    expect(forest.byId['agent-2']!.childIds).toEqual([]);
    expect(forest.byId['agent-2']!.parentAgentId).toBe('agent-1');
    expect(forest.byId['agent-1']!.parentAgentId).toBe('main');

    expect(agentPath(forest, 'agent-2').map((node) => node.agentId)).toEqual([
      'main',
      'agent-1',
      'agent-2',
    ]);
    expect(agentChildren(forest, 'main').map((node) => node.agentId)).toEqual(['agent-1']);
    expect(agentSiblings(forest, 'agent-2')).toEqual([]);
    expect(forest.byId['agent-2']!.summary).toBe('done');
    expect(forest.byId['agent-2']!.status).toBe('completed');
    expect(forest.byId['agent-1']!.busy).toBe(true);
  });

  it('orders siblings stably even when input is reversed', () => {
    const forest = buildAgentForest(
      [],
      [
        roster({ agentId: 'main' }),
        roster({ agentId: 'agent-10', parentAgentId: 'main' }),
        roster({ agentId: 'agent-2', parentAgentId: 'main' }),
      ],
    );
    expect(forest.byId['main']!.childIds).toEqual(['agent-2', 'agent-10']);
    expect(agentSiblings(forest, 'agent-2').map((node) => node.agentId)).toEqual(['agent-10']);
  });

  it('prefers roster.parentAgentId over any other parent hint', () => {
    const forest = buildAgentForest(
      [live({ subagentId: 'agent-1', name: 'FromLive' })],
      [roster({ agentId: 'agent-1', parentAgentId: 'main', name: 'FromRoster' })],
      [task({ agentId: 'agent-1', parentAgentId: 'someone-else', name: 'FromTask' })],
    );
    expect(forest.byId['agent-1']!.parentAgentId).toBe('main');
    expect(forest.byId['agent-1']!.name).toBe('FromLive');
    expect(forest.roots.map((node) => node.agentId)).toEqual(['main']);
  });

  it('promotes agents with no parent to a main/root and keeps orphans as roots', () => {
    const forest = buildAgentForest(
      [live({ subagentId: 'agent-1', name: 'Orphan', status: 'running' })],
      [roster({ agentId: 'agent-2', parentAgentId: 'missing-parent', status: 'completed' })],
    );
    expect(forest.roots.map((node) => node.agentId)).toEqual(['agent-1', 'agent-2']);
    expect(forest.byId['agent-1']!.parentAgentId).toBeUndefined();
    expect(forest.byId['agent-2']!.parentAgentId).toBeUndefined();
  });

  it('breaks a 2-cycle at the max id, independent of input order', () => {
    const forward = buildAgentForest(
      [],
      [
        roster({ agentId: 'agent-1', parentAgentId: 'agent-2' }),
        roster({ agentId: 'agent-2', parentAgentId: 'agent-1' }),
      ],
    );
    const reverse = buildAgentForest(
      [],
      [
        roster({ agentId: 'agent-2', parentAgentId: 'agent-1' }),
        roster({ agentId: 'agent-1', parentAgentId: 'agent-2' }),
      ],
    );
    const expected = {
      roots: ['agent-2'],
      parent1: 'agent-2',
      parent2: undefined,
    };
    for (const forest of [forward, reverse]) {
      expect(forest.roots.map((node) => node.agentId)).toEqual(expected.roots);
      expect(forest.byId['agent-1']!.parentAgentId).toBe(expected.parent1);
      expect(forest.byId['agent-2']!.parentAgentId).toBe(expected.parent2);
      expect(forest.byId['agent-2']!.childIds).toEqual(['agent-1']);
      expect(() => agentPath(forest, 'agent-1')).not.toThrow();
      expect(agentPath(forest, 'agent-1').map((node) => node.agentId)).toEqual(['agent-2', 'agent-1']);
    }
  });

  it('breaks a 3-cycle at the max id, independent of input order', () => {
    const cycle = [
      roster({ agentId: 'agent-1', parentAgentId: 'agent-2' }),
      roster({ agentId: 'agent-2', parentAgentId: 'agent-3' }),
      roster({ agentId: 'agent-3', parentAgentId: 'agent-1' }),
    ];
    const forward = buildAgentForest([], cycle);
    const reverse = buildAgentForest([], [...cycle].reverse());
    for (const forest of [forward, reverse]) {
      expect(forest.byId['agent-3']!.parentAgentId).toBeUndefined();
      expect(forest.byId['agent-1']!.parentAgentId).toBe('agent-2');
      expect(forest.byId['agent-2']!.parentAgentId).toBe('agent-3');
      expect(forest.roots.map((node) => node.agentId)).toEqual(['agent-3']);
      expect(agentPath(forest, 'agent-1').map((node) => node.agentId)).toEqual([
        'agent-3',
        'agent-2',
        'agent-1',
      ]);
    }
  });

  it('discovers completed and background agents from roster/task without live blocks', () => {
    const forest = buildAgentForest(
      [],
      [roster({ agentId: 'agent-done', parentAgentId: 'main', status: 'completed', name: 'Done' })],
      [
        task({
          agentId: 'agent-bg',
          kind: 'agent',
          status: 'running',
          detached: true,
          description: 'Background researcher',
          parent_agent_id: 'main',
        }),
      ],
    );
    expect(forest.byId['agent-done']!.status).toBe('completed');
    expect(forest.byId['agent-done']!.name).toBe('Done');
    expect(forest.byId['agent-bg']!.status).toBe('background');
    expect(forest.byId['agent-bg']!.name).toBe('Background researcher');
    expect(forest.byId['agent-bg']!.busy).toBe(true);
    expect(forest.byId['main']!.childIds).toEqual(['agent-bg', 'agent-done']);
  });

  it('lets live blocks override status/model/summary while roster fills parent/name', () => {
    const forest = buildAgentForest(
      [
        live({
          subagentId: 'agent-1',
          name: '',
          model: 'kimi-code/k3',
          status: 'failed',
          summary: 'live summary',
          error: 'boom',
          toolCallCount: 4,
        }),
      ],
      [
        roster({
          agentId: 'agent-1',
          parentAgentId: 'main',
          name: 'Roster Name',
          model: 'stale-model',
          status: 'running',
          summary: 'stale',
          toolCallCount: 1,
        }),
      ],
    );
    const node = forest.byId['agent-1']!;
    expect(node.parentAgentId).toBe('main');
    expect(node.name).toBe('Roster Name');
    expect(node.model).toBe('kimi-code/k3');
    expect(node.status).toBe('failed');
    expect(node.summary).toBe('live summary');
    expect(node.error).toBe('boom');
    expect(node.toolCallCount).toBe(4);
  });

  it('uses task fallback when roster and live omit identity fields', () => {
    const forest = buildAgentForest(
      [live({ subagentId: 'agent-1', name: '', status: 'running' })],
      [roster({ agentId: 'agent-1', parentAgentId: 'main', name: '' })],
      [
        task({
          id: 'task-1',
          agentId: 'agent-1',
          description: 'Fallback name',
          model: 'kimi-k2',
          thinking_effort: 'high',
          started_at: '2026-01-01T00:00:00.000Z',
        }),
      ],
    );
    expect(forest.byId['agent-1']!.name).toBe('Fallback name');
    expect(forest.byId['agent-1']!.model).toBe('kimi-k2');
    expect(forest.byId['agent-1']!.thinkingEffort).toBe('high');
    expect(forest.byId['agent-1']!.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('ignores tasks that do not carry an explicit agentId', () => {
    const forest = buildAgentForest([], undefined, [
      task({ id: 'bash-1', kind: 'bash', description: 'ls', status: 'running' }),
      task({ id: 'agent-9', kind: 'subagent', description: 'Explore' }),
      task({ id: 'task-only', kind: 'agent', description: 'No agent field' }),
    ]);
    expect(Object.keys(forest.byId)).toEqual([]);
  });

  it('lets roster identity fields override a conflicting task when live is absent', () => {
    const forest = buildAgentForest(
      [],
      [
        roster({
          agentId: 'agent-1',
          parentAgentId: 'main',
          status: 'failed',
          model: 'roster-model',
          thinkingEffort: 'low',
          startedAt: '2026-02-01T00:00:00.000Z',
          endedAt: '2026-02-01T01:00:00.000Z',
          summary: 'roster summary',
        }),
      ],
      [
        task({
          agentId: 'agent-1',
          parentAgentId: 'someone-else',
          status: 'completed',
          model: 'task-model',
          thinking_effort: 'high',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T01:00:00.000Z',
          summary: 'task summary',
        }),
      ],
    );
    const node = forest.byId['agent-1']!;
    expect(node.parentAgentId).toBe('main');
    expect(node.status).toBe('failed');
    expect(node.busy).toBe(false);
    expect(node.model).toBe('roster-model');
    expect(node.thinkingEffort).toBe('low');
    expect(node.startedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(node.endedAt).toBe('2026-02-01T01:00:00.000Z');
    expect(node.summary).toBe('roster summary');
  });

  it('synthesizes main from any parentAgentId=main source, but keeps ghost parents as orphans', () => {
    const fromTask = buildAgentForest([], undefined, [
      task({ agentId: 'agent-1', parent_agent_id: 'main', status: 'completed' }),
    ]);
    expect(fromTask.roots.map((node) => node.agentId)).toEqual(['main']);
    expect(fromTask.byId['agent-1']!.parentAgentId).toBe('main');
    expect(fromTask.byId['main']!.childIds).toEqual(['agent-1']);

    const fromLive = buildAgentForest([
      live({ subagentId: 'agent-2', parentAgentId: 'main', status: 'running' }),
    ]);
    expect(fromLive.roots.map((node) => node.agentId)).toEqual(['main']);
    expect(fromLive.byId['agent-2']!.parentAgentId).toBe('main');

    const ghost = buildAgentForest(
      [live({ subagentId: 'agent-3', parentAgentId: 'missing-parent', status: 'running' })],
      undefined,
      [task({ agentId: 'agent-4', parentAgentId: 'also-missing', status: 'completed' })],
    );
    expect(ghost.roots.map((node) => node.agentId)).toEqual(['agent-3', 'agent-4']);
    expect(ghost.byId['agent-3']!.parentAgentId).toBeUndefined();
    expect(ghost.byId['agent-4']!.parentAgentId).toBeUndefined();
    expect(ghost.byId['main']).toBeUndefined();
  });

  it('treats reserved prototype keys as own agent ids', () => {
    const forest = buildAgentForest(
      [
        live({ subagentId: '__proto__', name: 'Proto', status: 'running' }),
        live({ subagentId: 'constructor', name: 'Ctor', status: 'completed' }),
        live({ subagentId: 'toString', name: 'ToString', status: 'failed' }),
      ],
      [roster({ agentId: 'main', name: 'Main' })],
    );

    expect(Object.getPrototypeOf(forest.byId)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(forest.byId, '__proto__')).toBe(true);
    expect(Object.keys(forest.byId).sort()).toEqual(['__proto__', 'constructor', 'main', 'toString']);
    expect(forest.byId['__proto__']!.name).toBe('Proto');
    expect(forest.byId.constructor!.name).toBe('Ctor');
    expect(forest.byId.toString!.name).toBe('ToString');
    expect(forest.byId['constructor']!.busy).toBe(false);
    expect(forest.byId['toString']!.busy).toBe(false);
    expect(agentPath(forest, '__proto__').map((node) => node.agentId)).toEqual(['__proto__']);
    expect(agentChildren(forest, '__proto__')).toEqual([]);
    expect(agentChildren(forest, 'main')).toEqual([]);
    expect(agentSiblings(forest, '__proto__').map((node) => node.agentId)).toEqual([
      'main',
      'constructor',
      'toString',
    ]);
  });

  it('does not mutate input arrays or objects', () => {
    const blocks = [live({ subagentId: 'agent-1', name: 'Child' })];
    const rosterItems = [roster({ agentId: 'agent-1', parentAgentId: 'main', name: 'Roster' })];
    const tasks = [task({ agentId: 'agent-bg', status: 'completed', description: 'Done' })];
    const before = {
      blocks: snapshotJson(blocks),
      roster: snapshotJson(rosterItems),
      tasks: snapshotJson(tasks),
    };
    buildAgentForest(blocks, rosterItems, tasks);
    expect(snapshotJson(blocks)).toBe(before.blocks);
    expect(snapshotJson(rosterItems)).toBe(before.roster);
    expect(snapshotJson(tasks)).toBe(before.tasks);
    expect(blocks[0]).toEqual(live({ subagentId: 'agent-1', name: 'Child' }));
  });

  it('returns an empty forest for empty inputs', () => {
    const empty = buildAgentForest([]);
    expect(empty.roots).toEqual([]);
    expect(Object.keys(empty.byId)).toEqual([]);
    expect(Object.getPrototypeOf(empty.byId)).toBeNull();
    expect(empty.byId.constructor).toBeUndefined();
  });

  it('builds 0 / 1 / 2+ independent roots from live blocks alone', () => {
    expect(buildAgentForest([])).toEqual({ roots: [], byId: {} });

    const one = buildAgentForest([live({ subagentId: 'agent-1', name: 'Solo', status: 'running' })]);
    expect(one.roots.map((node) => node.agentId)).toEqual(['agent-1']);
    expect(one.byId['agent-1']!.parentAgentId).toBeUndefined();
    expect(one.byId['agent-1']!.childIds).toEqual([]);
    expect(one.byId['agent-1']!.busy).toBe(true);

    const two = buildAgentForest([
      live({ subagentId: 'agent-2', name: 'B', status: 'completed' }),
      live({ subagentId: 'agent-1', name: 'A', status: 'running' }),
    ]);
    expect(two.roots.map((node) => node.agentId)).toEqual(['agent-1', 'agent-2']);
    expect(two.byId['agent-1']!.busy).toBe(true);
    expect(two.byId['agent-2']!.busy).toBe(false);
  });

  it('lets live status override a stale roster busy flag', () => {
    const running = buildAgentForest(
      [live({ subagentId: 'agent-1', name: 'Child', status: 'running' })],
      [roster({ agentId: 'agent-1', parentAgentId: 'main', status: 'completed', busy: false })],
    );
    expect(running.byId['agent-1']!.status).toBe('running');
    expect(running.byId['agent-1']!.busy).toBe(true);

    const done = buildAgentForest(
      [live({ subagentId: 'agent-1', name: 'Child', status: 'completed' })],
      [roster({ agentId: 'agent-1', parentAgentId: 'main', status: 'running', busy: true })],
    );
    expect(done.byId['agent-1']!.status).toBe('completed');
    expect(done.byId['agent-1']!.busy).toBe(false);
  });
});

describe('stabilizeAgentForest', () => {
  const rosterItems = (grandchildStatus: 'running' | 'completed') => [
    roster({ agentId: 'main', name: 'Main' }),
    roster({
      agentId: 'agent-history',
      parentAgentId: 'main',
      name: 'Historical',
      status: 'completed',
    }),
    roster({
      agentId: 'agent-live',
      parentAgentId: 'main',
      name: 'Live branch',
      status: 'running',
    }),
    roster({
      agentId: 'agent-grandchild',
      parentAgentId: 'agent-live',
      name: 'Grandchild',
      status: grandchildStatus,
    }),
  ];

  it('returns the previous forest when a rebuild is semantically identical', () => {
    const previous = buildAgentForest([], rosterItems('running'));
    expect(stabilizeAgentForest(previous, buildAgentForest([], rosterItems('running')))).toBe(previous);
  });

  it('shares unaffected history while refreshing the changed branch and its ancestors', () => {
    const previous = buildAgentForest([], rosterItems('running'));
    const stable = stabilizeAgentForest(
      previous,
      buildAgentForest([], rosterItems('completed')),
    );

    expect(stable).not.toBe(previous);
    expect(stable.byId['agent-history']).toBe(previous.byId['agent-history']);
    expect(stable.byId['agent-grandchild']).not.toBe(previous.byId['agent-grandchild']);
    expect(stable.byId['agent-live']).not.toBe(previous.byId['agent-live']);
    expect(stable.byId['main']).not.toBe(previous.byId['main']);
  });
});

describe('agentPath / agentChildren / agentSiblings', () => {
  const forest = buildAgentForest(
    [],
    [
      roster({ agentId: 'main' }),
      roster({ agentId: 'agent-1', parentAgentId: 'main' }),
      roster({ agentId: 'agent-2', parentAgentId: 'main' }),
      roster({ agentId: 'agent-3', parentAgentId: 'agent-1' }),
    ],
  );

  it('returns empty collections for unknown ids', () => {
    expect(agentPath(forest, 'missing')).toEqual([]);
    expect(agentChildren(forest, 'missing')).toEqual([]);
    expect(agentSiblings(forest, 'missing')).toEqual([]);
  });

  it('lists siblings excluding self', () => {
    expect(agentSiblings(forest, 'agent-1').map((node) => node.agentId)).toEqual(['agent-2']);
    expect(agentSiblings(forest, 'main')).toEqual([]);
  });
});

describe('mergeAgentTranscript', () => {
  it('uses the server page as the base and overlays live blocks with the same id', () => {
    const server = page(
      [
        block({ id: 'a1', kind: 'assistant', turnId: 'turn-1' }),
        block({ id: 't1', kind: 'tool', status: 'running' }),
      ],
      { hasMore: true, oldestTurnId: 'turn-1', seq: 4, busy: false, toolCallCount: 1 },
    );
    const liveBlocks = [
      block({ id: 't1', kind: 'tool', status: 'done' }),
      block({ id: 'a2', kind: 'assistant', turnId: 'turn-2' }),
    ];
    const merged = mergeAgentTranscript(server, liveBlocks);
    expect(merged.blocks.map((item) => item.id)).toEqual(['a1', 't1', 'a2']);
    expect(merged.blocks[1]).toMatchObject({ id: 't1', status: 'done' });
    expect(merged.hasMore).toBe(true);
    expect(merged.oldestTurnId).toBe('turn-1');
    expect(merged.seq).toBe(4);
  });

  it('keeps server-only and live-only blocks', () => {
    const merged = mergeAgentTranscript(
      page([block({ id: 'server-only', kind: 'user', turnId: 'turn-1' })]),
      [block({ id: 'live-only', kind: 'assistant' })],
    );
    expect(merged.blocks.map((item) => item.id)).toEqual(['server-only', 'live-only']);
  });

  it('takes max(toolCallCount) from counts and derived tool blocks', () => {
    const merged = mergeAgentTranscript(
      page([block({ id: 't1', kind: 'tool' })], { toolCallCount: 2 }),
      {
        blocks: [block({ id: 't1', kind: 'tool' }), block({ id: 't2', kind: 'tool' })],
        toolCallCount: 1,
      },
      { toolCallCount: 5 },
    );
    expect(merged.toolCallCount).toBe(5);
    const derived = mergeAgentTranscript(
      page([block({ id: 't1', kind: 'tool' })], { toolCallCount: 1 }),
      [block({ id: 't2', kind: 'tool' }), block({ id: 't3', kind: 'tool' })],
    );
    expect(derived.toolCallCount).toBe(3);
  });

  it('treats live as the busy authority when present, else server/fallback', () => {
    expect(
      mergeAgentTranscript(page([], { busy: false }), { blocks: [], busy: true }).busy,
    ).toBe(true);
    expect(mergeAgentTranscript(page([], { busy: true }), []).busy).toBe(true);
    expect(
      mergeAgentTranscript(page([], { busy: false }), [], { busy: true }).busy,
    ).toBe(true);
    expect(
      mergeAgentTranscript(page([]), [block({ id: 't1', kind: 'tool', status: 'running' })]).busy,
    ).toBe(true);
    expect(mergeAgentTranscript(page([block({ id: 'a1', kind: 'assistant' })])).busy).toBe(false);
  });

  it('preserves fallback-captured blocks that neither side already has', () => {
    const merged = mergeAgentTranscript(
      page([block({ id: 's1', kind: 'assistant' })]),
      [block({ id: 'l1', kind: 'assistant' })],
      { blocks: [block({ id: 's1', kind: 'assistant' }), block({ id: 'f1', kind: 'notice' })] },
    );
    expect(merged.blocks.map((item) => item.id)).toEqual(['s1', 'l1', 'f1']);
  });

  it('keeps live streaming overlays when a later REST page still reports the older status', () => {
    const first = mergeAgentTranscript(
      page([block({ id: 't1', kind: 'tool', status: 'running', streaming: true })], {
        toolCallCount: 1,
        busy: false,
      }),
      { blocks: [block({ id: 't1', kind: 'tool', status: 'running', streaming: true })], busy: true, toolCallCount: 3 },
    );
    const refreshed = mergeAgentTranscript(
      page([block({ id: 't1', kind: 'tool', status: 'running' })], { toolCallCount: 1, busy: false }),
      { blocks: first.blocks, busy: true, toolCallCount: first.toolCallCount },
    );
    expect(refreshed.blocks[0]).toMatchObject({ id: 't1', streaming: true, status: 'running' });
    expect(refreshed.busy).toBe(true);
    expect(refreshed.toolCallCount).toBe(3);
  });

  it('collapses same-turn live and REST assistant/thinking/user into one block', () => {
    const server = page([
      block({ id: 'agent-frame-f1', kind: 'assistant', turnId: '1', text: 'Hello world', streaming: false }),
      block({ id: 'agent-frame-f2', kind: 'thinking', turnId: '1', text: 'Hmm', streaming: false }),
      block({ id: 'user-agent-turn-1-prompt', kind: 'user', turnId: '1', text: 'Do it' }),
    ]);
    const liveBlocks = [
      block({ id: 'assistant-live-1', kind: 'assistant', turnId: '1', text: 'Hello', streaming: true }),
      block({ id: 'thinking-live-1', kind: 'thinking', turnId: '1', text: 'Hmm', streaming: true }),
      block({ id: 'user-turn-1-prompt', kind: 'user', turnId: '1', text: 'Do it' }),
    ];
    const merged = mergeAgentTranscript(server, liveBlocks);
    expect(merged.blocks.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(merged.blocks.filter((item) => item.kind === 'thinking')).toHaveLength(1);
    expect(merged.blocks.filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(merged.blocks.find((item) => item.kind === 'assistant')).toMatchObject({
      text: 'Hello world',
      streaming: false,
      turnId: '1',
    });
    const again = mergeAgentTranscript(server, liveBlocks);
    expect(again.blocks.map((item) => item.id)).toEqual(merged.blocks.map((item) => item.id));
  });

  it('keeps two same-turn REST assistants distinct across a second poll', () => {
    const rest = page([
      block({ id: 'agent-frame-a', kind: 'assistant', turnId: '1', text: 'first' }),
      block({ id: 'agent-frame-b', kind: 'assistant', turnId: '1', text: 'second' }),
    ]);
    const first = applyNewestAgentPage(null, 'agent-1', rest);
    const second = applyNewestAgentPage(first, 'agent-1', rest);
    expect(second.page.blocks.map((item) => item.id)).toEqual(['agent-frame-a', 'agent-frame-b']);
    expect(second.page.blocks.map((item) => item.text)).toEqual(['first', 'second']);
  });

  it('pairs the first live assistant with the first REST frame and keeps a second live step', () => {
    const merged = mergeAgentTranscript(
      page([block({ id: 'agent-frame-a', kind: 'assistant', turnId: '1', text: 'first', streaming: false })]),
      [
        block({ id: 'assistant-live-1', kind: 'assistant', turnId: '1', text: 'first…', streaming: true }),
        block({ id: 'assistant-live-1-final-s2', kind: 'assistant', turnId: '1', text: 'step two', streaming: true }),
      ],
    );
    expect(merged.blocks.map((item) => item.id)).toEqual(['agent-frame-a', 'assistant-live-1-final-s2']);
    expect(merged.blocks[0]).toMatchObject({ text: 'first', streaming: false });
    expect(merged.blocks[1]).toMatchObject({ id: 'assistant-live-1-final-s2', text: 'step two' });
  });

  it('converges to two REST frames when the second page arrives, without a third copy', () => {
    const live = [
      block({ id: 'assistant-live-1', kind: 'assistant', turnId: '1', text: 'first…', streaming: true }),
      block({ id: 'assistant-live-1-final-s2', kind: 'assistant', turnId: '1', text: 'step two', streaming: true }),
    ];
    const firstPage = mergeAgentTranscript(
      page([block({ id: 'agent-frame-a', kind: 'assistant', turnId: '1', text: 'first' })]),
      live,
    );
    const secondPage = mergeAgentTranscript(
      page([
        block({ id: 'agent-frame-a', kind: 'assistant', turnId: '1', text: 'first' }),
        block({ id: 'agent-frame-b', kind: 'assistant', turnId: '1', text: 'second' }),
      ]),
      firstPage.blocks,
    );
    expect(secondPage.blocks.map((item) => item.id)).toEqual(['agent-frame-a', 'agent-frame-b']);
    expect(secondPage.blocks.map((item) => item.text)).toEqual(['first', 'second']);
  });

  it.each(['thinking', 'user'] as const)('pairs same-turn %s live and REST 1:1 without collapsing extras', (kind) => {
    const merged = mergeAgentTranscript(
      page([block({ id: `agent-frame-${kind}-a`, kind, turnId: '9', text: 'one' })]),
      [
        block({ id: kind === 'user' ? 'user-turn-9-prompt' : 'thinking-live-9', kind, turnId: '9', text: 'one…', streaming: kind !== 'user' }),
        block({ id: kind === 'user' ? 'user-turn-9-extra' : 'thinking-live-9-final-s2', kind, turnId: '9', text: 'two', streaming: kind !== 'user' }),
      ],
    );
    expect(merged.blocks.filter((item) => item.kind === kind)).toHaveLength(2);
    expect(merged.blocks[0]).toMatchObject({ id: `agent-frame-${kind}-a`, text: 'one' });
    expect(merged.blocks[1]?.text).toBe('two');
  });

  it('keeps same text on different turns as separate blocks', () => {
    const merged = mergeAgentTranscript(
      page([
        block({ id: 'agent-frame-a', kind: 'assistant', turnId: '1', text: 'same' }),
        block({ id: 'agent-frame-b', kind: 'assistant', turnId: '2', text: 'same' }),
      ]),
      [block({ id: 'assistant-live-2', kind: 'assistant', turnId: '2', text: 'same', streaming: true })],
    );
    expect(merged.blocks.filter((item) => item.kind === 'assistant')).toHaveLength(2);
    expect(merged.blocks.map((item) => item.turnId)).toEqual(['1', '2']);
  });

  it('keeps REST agentRefs when live overlay omits them', () => {
    const merged = mergeAgentTranscript(
      page([
        block({
          id: 'tool-call-1',
          kind: 'tool',
          status: 'done',
          agentRefs: [{ agentId: 'agent-1', role: 'child' }],
        }),
      ]),
      [block({ id: 'tool-call-1', kind: 'tool', status: 'running' })],
    );
    expect(merged.blocks[0]).toMatchObject({
      id: 'tool-call-1',
      status: 'running',
      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
    });
  });

  it('does not mutate the server page, live blocks, or fallback', () => {
    const server = page([block({ id: 's1', kind: 'assistant' })], { hasMore: true });
    const liveBlocks = [block({ id: 's1', kind: 'assistant', streaming: true })];
    const fallback = { blocks: [block({ id: 'f1', kind: 'notice' })] };
    const before = {
      server: snapshotJson(server),
      live: snapshotJson(liveBlocks),
      fallback: snapshotJson(fallback),
    };
    mergeAgentTranscript(server, liveBlocks, fallback);
    expect(snapshotJson(server)).toBe(before.server);
    expect(snapshotJson(liveBlocks)).toBe(before.live);
    expect(snapshotJson(fallback)).toBe(before.fallback);
  });
});

describe('prependOlderAgentPage / cursor advance', () => {
  it('prepends older blocks, drops overlapping ids, and keeps oldest→newest order', () => {
    const current = page(
      [block({ id: 't2', kind: 'assistant', turnId: 'turn-2' }), block({ id: 't3', kind: 'assistant', turnId: 'turn-3' })],
      { hasMore: true, oldestTurnId: 'turn-2', seq: 20 },
    );
    const older = page(
      [
        block({ id: 't0', kind: 'user', turnId: 'turn-0' }),
        block({ id: 't1', kind: 'assistant', turnId: 'turn-1' }),
        block({ id: 't2', kind: 'assistant', turnId: 'turn-2' }),
      ],
      { hasMore: true, oldestTurnId: 'turn-0', seq: 5 },
    );
    const next = prependOlderAgentPage(current, older);
    expect(next.blocks.map((item) => item.id)).toEqual(['t0', 't1', 't2', 't3']);
    expect(next.oldestTurnId).toBe('turn-0');
    expect(next.hasMore).toBe(true);
    expect(next.seq).toBe(20);
  });

  it('converges hasMore=false and advances the cursor from the older page', () => {
    const current = page([block({ id: 't2', turnId: 'turn-2' })], {
      hasMore: true,
      oldestTurnId: 'turn-2',
    });
    const older = page([block({ id: 't1', turnId: 'turn-1' })], {
      hasMore: false,
      oldestTurnId: 'turn-1',
    });
    const next = prependOlderAgentPage(current, older);
    expect(next.hasMore).toBe(false);
    expect(next.oldestTurnId).toBe('turn-1');
    expect(advanceAgentHistoryCursor(current, older)).toEqual({
      hasMore: false,
      oldestTurnId: 'turn-1',
      seq: undefined,
    });
  });

  it('treats an empty older page as history exhaustion', () => {
    const current = page([block({ id: 't1', turnId: 'turn-1' })], {
      hasMore: true,
      oldestTurnId: 'turn-1',
      seq: 3,
    });
    const next = prependOlderAgentPage(current, page([], { hasMore: true, oldestTurnId: 'ghost' }));
    expect(next.blocks.map((item) => item.id)).toEqual(['t1']);
    expect(next.hasMore).toBe(false);
    expect(next.oldestTurnId).toBe('turn-1');
    expect(next.seq).toBe(3);
  });

  it('does not mutate either page', () => {
    const current = page([block({ id: 't2' })], { hasMore: true, oldestTurnId: 'turn-2' });
    const older = page([block({ id: 't1' }), block({ id: 't2' })], {
      hasMore: false,
      oldestTurnId: 'turn-1',
    });
    const before = { current: snapshotJson(current), older: snapshotJson(older) };
    prependOlderAgentPage(current, older);
    expect(snapshotJson(current)).toBe(before.current);
    expect(snapshotJson(older)).toBe(before.older);
  });
});

describe('applyNewestAgentPage / resetAgentHistoryCache', () => {
  it('keeps the beforeTurn cursor when a newer page is applied', () => {
    const older = applyNewestAgentPage(null, 'agent-1', page(
      [block({ id: 't0', kind: 'assistant', turnId: 'turn-0' })],
      { hasMore: true, oldestTurnId: 'turn-0' },
    ));
    const prepended = {
      agentId: 'agent-1',
      page: prependOlderAgentPage(
        page([block({ id: 't2', kind: 'assistant', turnId: 'turn-2' })], {
          hasMore: true,
          oldestTurnId: 'turn-2',
        }),
        older.page,
      ),
    };
    const refreshed = applyNewestAgentPage(
      prepended,
      'agent-1',
      page([block({ id: 't2', kind: 'assistant', turnId: 'turn-2' })], {
        hasMore: true,
        oldestTurnId: 'turn-2',
      }),
    );
    expect(refreshed.page.oldestTurnId).toBe('turn-0');
    expect(refreshed.page.blocks.map((item) => item.id)).toEqual(['t0', 't2']);
  });

  it('resets cache when the selected agent changes', () => {
    const cache = applyNewestAgentPage(null, 'agent-1', page([block({ id: 'a' })], { oldestTurnId: 't1' }));
    expect(resetAgentHistoryCache(cache, 'agent-2')).toBeNull();
    expect(resetAgentHistoryCache(cache, 'agent-1')).toBe(cache);
  });
});
