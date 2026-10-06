// @vitest-environment jsdom

/**
 * The cockpit as it renders: what a reader can tell from the panel without
 * opening anything, and what the graph refuses to claim.
 *
 * These are the cases the design names as the ones that decide whether the
 * cockpit is worth having: a fleet you can read without reading every row, a
 * session that is not finished when one of its parts is, and a wait that is
 * the reader's own rather than the agent's age.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentForest, AgentTreeNode, ApprovalBlock } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import type { Task } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { CockpitOverview } from './CockpitOverview';
import type { OverviewFigures } from '../agent-panel/InspectorOverview';

// The cockpit reads whole-tree background work over the connection and, with
// no controller, falls back to the routed state's own collection. Both are
// stubbed here. The read resolves to a page with no items and no continuation
// so the effect settles and the tests below are about the graph rather than
// about transport; the read's own states are covered by the coverage-note
// cases at the end of this file.
const { EMPTY_AGENT_TASK_PAGE } = vi.hoisted(() => ({
  EMPTY_AGENT_TASK_PAGE: {
    items: [] as unknown[],
    owners: [] as unknown[],
    coverage: {
      total_owners: 0, completed_owners: 0, failed_owners: 0, pending_owners: 0,
      inventory_complete: true, complete: true, failures: [] as unknown[],
    },
    has_more: false,
    partial: false,
    consistency: 'incremental' as const,
    started_at: '2026-10-05T00:00:00.000Z',
    observed_at: '2026-10-05T00:00:00.000Z',
  },
}));

// `useConnection` hands back a fresh value object on every call, so the
// client itself is hoisted into a stable const: a fresh `client` identity per
// render would restart the paged walk on every page it fetched.
const { connectionClient } = vi.hoisted(() => ({ connectionClient: { listAgentTasks: vi.fn() } }));

vi.mock('../../state/connection', () => ({
  useOptionalControllerRegistry: () => null,
  useConnection: () => ({ client: connectionClient }),
}));

const MINUTE = 60_000;
// The graph's clock is the real one (`useNow`), so the fixtures below are
// written relative to the moment the test runs rather than a fixed instant.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function node(agentId: string, overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    agentId, name: agentId, label: agentId, status: 'completed', busy: false,
    toolCallCount: 0, childIds: [], ...overrides,
  };
}

function forestOf(nodes: readonly AgentTreeNode[]): AgentForest {
  return { roots: [nodes[0]!], byId: Object.fromEntries(nodes.map((entry) => [entry.agentId, entry])) };
}

const noFigures: OverviewFigures = {};

type Props = Parameters<typeof CockpitOverview>[0];

const baseProps: Omit<Props, 'forest' | 'agentId'> = {
  sessionId: 's1',
  blocks: [],
  figures: noFigures,
  expandedBranches: new Set<string>(),
  onToggleBranch: () => {},
  sessionPending: [],
  mainBusy: false,
  turnStartedAt: undefined,
  mainLabel: 'Main agent',
  sessionTasks: [],
  onOpenAgent: () => {},
};

let root: Root;
let container: HTMLDivElement;
let current: Props = { ...baseProps, agentId: MAIN_AGENT_ID, forest: forestOf([node(MAIN_AGENT_ID)]) };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'en');
  connectionClient.listAgentTasks.mockReset();
  connectionClient.listAgentTasks.mockResolvedValue(EMPTY_AGENT_TASK_PAGE);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // The harness re-renders the same root, so the props start from the base
  // every test: otherwise one test's expansion leaks into the next.
  current = { ...baseProps, agentId: MAIN_AGENT_ID, forest: forestOf([node(MAIN_AGENT_ID)]) };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render(props: Partial<Props> = {}) {
  current = { ...current, ...props };
  await act(async () => {
    root.render(<I18nProvider><CockpitOverview {...current} /></I18nProvider>);
  });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

const q = (selector: string) => container.querySelector(selector);
const all = (selector: string) => [...container.querySelectorAll(selector)];

describe('CockpitOverview', () => {
  it('reads the session, not the selected agent, and says so in the DOM', async () => {
    await render({
      agentId: 'agent-api',
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['agent-docs', 'agent-api'] }),
        node('agent-docs', { label: 'Docs lead', parentAgentId: MAIN_AGENT_ID, childIds: ['agent-docs-w1'] }),
        node('agent-docs-w1', { label: 'Docs worker 1', parentAgentId: 'agent-docs' }),
        node('agent-api', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, status: 'running' }),
      ]),
    });
    // The subject is the session; the selected agent is only a highlight.
    expect(q('[data-cockpit-subject]')?.getAttribute('data-cockpit-subject')).toBe('session');
    // Both branches are present even though a subagent is selected.
    expect(all('[data-cockpit-branch]')).toHaveLength(2);
    expect(container.textContent).toContain('Docs lead');
    expect(container.textContent).toContain('API lead');
  });

  it('folds sixty-five agents into their branches and says how many are folded', async () => {
    const children = Array.from({ length: 8 }, (_, i) => `lead-${i}`);
    const nodes = [node(MAIN_AGENT_ID, { childIds: children })];
    for (const lead of children) {
      const workers = Array.from({ length: 8 }, (_, i) => `${lead}-w${i}`);
      nodes.push(node(lead, { label: `Lead ${lead}`, parentAgentId: MAIN_AGENT_ID, childIds: workers }));
      for (const w of workers) nodes.push(node(w, { label: `Worker ${w}`, parentAgentId: lead }));
    }
    await render({ forest: forestOf(nodes) });
    // Eight rows, not seventy-two.
    expect(all('[data-cockpit-branch]')).toHaveLength(8);
    expect(all('[data-cockpit-lane]')).toHaveLength(0);
    // Every agent but main is inside a folded branch: 8 leads + 64 workers.
    expect(q('[data-cockpit-folded-note]')?.textContent).toContain('72');
  });

  it('counts the whole session in the legend, on the same footing as its total', async () => {
    // The loaded forest here is main + one child. The server counted a session
    // of 300 agents, and the legend must describe that: an old subagent that
    // finished while nobody was looking is still one of the 300.
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['lead'] }),
        node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID }),
      ]),
      agentCounts: { total: 301, subagents: 300, completed: 280, failed: 6, cancelled: 5, active: 7, unknown: 2 },
      mainBusy: true,
    });
    // The total is the session's, not the loaded two.
    expect(q('[data-composition-total]')?.textContent).toContain('301');
    // The buckets are the session's mix: the loaded forest would say 1-2.
    expect(q('[data-composition-state="done"]')?.textContent).toContain('280');
    expect(q('[data-composition-state="failed"]')?.textContent).toContain('6');
    expect(q('[data-composition-state="stopped"]')?.textContent).toContain('5');
    expect(q('[data-composition-state="unknown"]')?.textContent).toContain('2');
    // Main is in `total` but in none of the five buckets, and this main is
    // working, so it joins the running one: 7 subagents + main = 8. Printing
    // the buckets against / 300 would leave main unaccounted for.
    expect(q('[data-composition-state="running"]')?.textContent).toContain('8');
    // The folded note still describes what is on screen, which is the honest
    // claim: it must not be inflated to claim all 300 are drawn.
    expect(q('[data-cockpit-folded-note]')?.textContent).toContain('1');
  });

  it('adds up: buckets plus main equal the session total', async () => {
    // The cross-layer footing in one assertion. The five buckets are subagents
    // only, so the row is only correct if main lands in exactly one of them.
    const counts = { total: 301, subagents: 300, completed: 280, failed: 6, cancelled: 5, active: 7, unknown: 2 };
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['lead'] }),
      node('lead', { parentAgentId: MAIN_AGENT_ID }),
    ]);
    const sumOf = () => [...container.querySelectorAll('[data-composition-state]')]
      .reduce((total, node) => total + Number(/^\s*(\d+)/.exec(node.textContent ?? '')?.[1] ?? 0), 0);
    const countOf = (state: string) => Number(
      /^\s*(\d+)/.exec(container.querySelector(`[data-composition-state="${state}"]`)?.textContent ?? '')?.[1] ?? 0,
    );

    await render({ forest, agentCounts: counts, mainBusy: true });
    // Main is working, so it joins the 7 active subagents: 8 running.
    expect(countOf('running')).toBe(8);
    expect(sumOf()).toBe(counts.total);

    await render({ mainBusy: false });
    // Main is idle, so it joins the 280 completed instead, and the same total
    // still adds up — main moves between buckets, it is never dropped.
    expect(countOf('running')).toBe(7);
    expect(countOf('done')).toBe(281);
    expect(sumOf()).toBe(counts.total);
  });

  it('reads a main-only session as one agent of one, not zero of one', async () => {
    // The same footing at its smallest: a session with no subagents has a
    // `subagents` of 0 and a `total` of 1, and the one agent is main. It must
    // not print an empty row against a total of 1.
    await render({
      forest: forestOf([node(MAIN_AGENT_ID)]),
      agentCounts: { total: 1, subagents: 0, completed: 0, failed: 0, cancelled: 0, active: 0, unknown: 0 },
      mainBusy: false,
    });
    expect(q('[data-composition-total]')?.textContent).toContain('1');
    const states = [...container.querySelectorAll('[data-composition-state]')];
    expect(states).toHaveLength(1);
    // Main is idle, so it is the one done agent in the row.
    expect(states[0]?.getAttribute('data-composition-state')).toBe('done');
    expect(states[0]?.textContent).toContain('1');
  });

  it('counts a cold non-terminal agent as unknown, not running', async () => {
    // `active` is a live non-terminal subagent. A cold registration the session
    // recorded and then went cold is `unknown`, and the two must not merge into
    // one "running" number that claims work in flight.
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['cold', 'live'] }),
        node('cold', { label: 'Cold worker', parentAgentId: MAIN_AGENT_ID }),
        node('live', { label: 'Live worker', parentAgentId: MAIN_AGENT_ID }),
      ]),
      agentCounts: { total: 3, subagents: 2, completed: 0, failed: 0, cancelled: 0, active: 1, unknown: 1 },
      expandedBranches: new Set(['cold', 'live']),
      mainBusy: false,
    });
    const running = q('[data-composition-state="running"]');
    const unknown = q('[data-composition-state="unknown"]');
    const done = q('[data-composition-state="done"]');
    // One live subagent, and main is idle so it joins done rather than running.
    expect(running?.textContent).toContain('1');
    expect(unknown?.textContent).toContain('1');
    expect(done?.textContent).toContain('1');
    // 1 running + 1 unknown + 1 done (main) = the total of 3.
    expect(q('[data-composition-total]')?.textContent).toContain('3');
  });

  it('falls back to the loaded roster when the server sends no counts', async () => {
    // An older server sends no inventory, so the legend says only what the
    // loaded agents support and makes no claim about the rest.
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['a', 'b'] }),
        node('a', { label: 'A', parentAgentId: MAIN_AGENT_ID }),
        node('b', { label: 'B', parentAgentId: MAIN_AGENT_ID }),
      ]),
      agentCounts: undefined,
    });
    const total = q('[data-composition-total]')?.textContent ?? '';
    expect(total).not.toContain('301');
    // Main plus the two children is all this client can speak for.
    expect(total).toMatch(/\/\s*3/);
  });

  it('shows a branch status band whose segments add up to the branch size', async () => {
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['lead'] }),
        node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, childIds: ['w1', 'w2', 'w3', 'w4'] }),
        node('w1', { status: 'completed' }),
        node('w2', { status: 'completed' }),
        node('w3', { status: 'failed' }),
        node('w4', { status: 'running' }),
      ]),
    });
    const band = q('[data-cockpit-branch="lead"] [data-cockpit-status-band]');
    expect(band).toBeTruthy();
    const segments = [...band!.querySelectorAll<HTMLElement>('[data-band-state]')];
    const total = segments.reduce((sum, el) => sum + Number.parseFloat(el.style.width || '0'), 0);
    expect(total).toBeCloseTo(100, 0);
    // The failure is visible as its own state, not folded into "ended".
    expect(band!.querySelector('[data-band-state="failed"]')).toBeTruthy();
  });

  it('keeps a finished parent with a waiting grandchild from reading as finished', async () => {
    const pending = [{
      kind: 'approval',
      id: 'a1',
      resolution: undefined,
      originAgentId: 'w2',
      request: {
        approval_id: 'a1', session_id: 's1', tool_call_id: 'c', tool_name: 'Bash',
        action: 'Run: x', tool_input_display: { kind: 'command', command: 'x' },
        created_at: ago(3 * MINUTE),
        expires_at: ago(10 * MINUTE),
      },
    } as ApprovalBlock];
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['lead'] }),
        // The lead reported back 29 minutes ago; its worker is the one blocked.
        node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, status: 'completed', childIds: ['w1', 'w2'], startedAt: ago(29 * MINUTE) }),
        node('w1', { parentAgentId: 'lead', status: 'completed' }),
        node('w2', { parentAgentId: 'lead', status: 'suspended', startedAt: ago(29 * MINUTE) }),
      ]),
      sessionPending: pending,
      expandedBranches: new Set(['lead']),
    });
    const waiting = q('[data-cockpit-lane="w2"]');
    expect(waiting?.getAttribute('data-lane-state')).toBe('waiting');
    expect(waiting?.getAttribute('data-lane-needs-user')).toBe('true');
    // The reader has waited 3 minutes, not the agent's 29.
    expect(waiting?.textContent).toContain('3');
    expect(waiting?.textContent).not.toContain('29');
    // The composition carries the obligation, so the session is not "all done".
    expect(q('[data-composition-state="waiting"][data-composition-needs-user="true"]')).toBeTruthy();
  });

  it('keeps a suspended agent that is not the reader out of the running count', async () => {
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['a', 'b'] }),
        node('a', { label: 'A', parentAgentId: MAIN_AGENT_ID, status: 'suspended' }),
        node('b', { label: 'B', parentAgentId: MAIN_AGENT_ID, status: 'running' }),
      ]),
      mainBusy: true,
      expandedBranches: new Set(['a', 'b']),
    });
    // Main plus B: the suspended one is not folded into the running count.
    expect(q('[data-composition-state="running"]')?.textContent).toContain('2');
    // And the non-user wait is its own segment, distinct from the reader's.
    expect(q('[data-composition-state="waiting"][data-composition-needs-user="false"]')).toBeTruthy();
    // The reader has nothing waiting on them, so that segment is absent.
    expect(q('[data-composition-state="waiting"][data-composition-needs-user="true"]')).toBeNull();
  });

  it('expands a branch into lanes in place rather than into another page', async () => {
    const forest = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['lead'] }),
      node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, childIds: ['w1'] }),
      node('w1', { label: 'API worker 1', parentAgentId: 'lead' }),
    ]);
    await render({ forest });
    expect(q('[data-cockpit-branch="lead"]')).toBeTruthy();
    await render({ expandedBranches: new Set(['lead']) });
    // Same graph, deeper: lanes, not a different page.
    expect(all('[data-cockpit-lane]')).toHaveLength(2);
    expect(q('[data-cockpit-branch="lead"]')).toBeNull();
    // The root lane and the axis are still there, so the reader keeps place.
    expect(q('[data-cockpit-main]')).toBeTruthy();
    expect(all('[data-cockpit-tick]').length).toBeGreaterThanOrEqual(2);
  });

  it('opens an owner agent from a branch row without leaving the graph', async () => {
    const onOpenAgent = vi.fn();
    await render({
      forest: forestOf([node(MAIN_AGENT_ID, { childIds: ['lead'] }), node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID })]),
      onOpenAgent,
    });
    await act(async () => { (q('[data-cockpit-open-branch="lead"]') as HTMLButtonElement).click(); });
    expect(onOpenAgent).toHaveBeenCalledWith('lead');
  });

  it('shows two arcs, not three, and no running-share capacity gauge', async () => {
    await render({
      forest: forestOf([node(MAIN_AGENT_ID, { childIds: ['a'] }), node('a', { parentAgentId: MAIN_AGENT_ID, status: 'running' })]),
      contextUsed: 100, contextLimit: 200,
      treeFigures: { cacheRate: 55, costUsd: 1.23 },
    });
    expect(all('[data-cockpit-gauge]')).toHaveLength(2);
    // The old third arc was "running / all agents", a ratio that means
    // nothing about capacity. Running now lives in the graph's composition,
    // where the denominator is the agent count, not in an arc.
    const gaugeLabels = all('[data-cockpit-gauge]').map((el) => el.getAttribute('data-cockpit-gauge'));
    expect(gaugeLabels).toEqual(['Context', 'Cache hits']);
  });

  it('marks a partly reported session rather than printing a full total', async () => {
    await render({
      forest: forestOf([node(MAIN_AGENT_ID, { childIds: ['a'] }), node('a', { parentAgentId: MAIN_AGENT_ID })]),
      treeFigures: { cacheRate: 55, costUsd: 1.23, incomplete: true },
    });
    expect(q('[data-cockpit-tree-partial]')).toBeTruthy();
  });

  it('draws an axis ending at now even when nothing was ever timed', async () => {
    await render({ forest: forestOf([node(MAIN_AGENT_ID)]) });
    const ticks = all('[data-cockpit-tick]').map((el) => el.textContent);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.at(-1)).toBe('now');
  });

  it('does not fall back to the visited agents once the whole-tree read has answered', async () => {
    // The session read has landed and says there is no background work at
    // all. A routed collection that happens to hold a row must not resurrect
    // it into a graph that has already been told the real answer: that row
    // belongs to one visited agent and would read as the whole tree.
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['a'] }),
        node('a', { parentAgentId: MAIN_AGENT_ID }),
      ]),
      sessionTasks: [{
        id: 't1', session_id: 's1', kind: 'bash', description: 'pnpm build --watch',
        status: 'running', created_at: ago(9 * MINUTE), started_at: ago(9 * MINUTE),
      } as Task],
    });
    expect(q('[data-cockpit-task="t1"]')).toBeNull();
    // A complete read needs no caveat: nothing is pending and nothing failed.
    expect(q('[data-cockpit-task-coverage]')).toBeNull();
    expect(q('[data-cockpit-task-read="pending"]')).toBeNull();
  });
});

/**
 * The whole-tree read, end to end through the rendered graph: an agent nobody
 * opened still contributes its background work, and the coverage the graph
 * prints matches what the server said.
 */
describe('CockpitOverview whole-tree background read', () => {
  const FLEET = forestOf([
    node(MAIN_AGENT_ID, { childIds: ['lead'] }),
    node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, childIds: ['worker'] }),
    node('worker', { label: 'API worker 2', parentAgentId: 'lead' }),
  ]);

  const page = (overrides: Record<string, unknown> = {}) => ({
    ...EMPTY_AGENT_TASK_PAGE,
    ...overrides,
  });

  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, session_id: 's1', kind: 'bash', description: `pnpm ${id}`, status: 'running',
    created_at: ago(9 * MINUTE), started_at: ago(9 * MINUTE), ...extra,
  });

  async function renderWith(read: () => Promise<unknown>) {
    connectionClient.listAgentTasks.mockReset();
    connectionClient.listAgentTasks.mockImplementation(read as never);
    await render({ forest: FLEET });
  }

  it('shows an unopened grandchild own running task on the first screen', async () => {
    await renderWith(async () => page({
      items: [task('t-worker', { owner_agent_id: 'worker', source: 'live' })],
      owners: [
        { owner_agent_id: MAIN_AGENT_ID, source: 'live', state: 'complete' },
        { owner_agent_id: 'lead', source: 'live', state: 'complete' },
        { owner_agent_id: 'worker', source: 'live', state: 'complete' },
      ],
      coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    }));
    const row = q('[data-cockpit-task="t-worker"]');
    // The whole point: this agent was never opened, and its work is here,
    // attributed to the real owner.
    expect(row).toBeTruthy();
    expect(row?.getAttribute('data-task-owner')).toBe('worker');
    expect(row?.getAttribute('data-task-state')).toBe('running');
    // And no coverage caveat, because the read was complete.
    expect(q('[data-cockpit-task-coverage]')).toBeNull();
    expect(q('[data-cockpit-task-read="pending"]')).toBeNull();
  });

  it('follows the next page until the server says the session is read', async () => {
    const pages = [
      page({
        items: [task('t1', { owner_agent_id: 'lead', source: 'live' })],
        has_more: true, next_page_token: 'cursor-1',
        coverage: { total_owners: 3, completed_owners: 1, failed_owners: 0, pending_owners: 2, inventory_complete: true, complete: false, failures: [] },
      }),
      page({
        items: [task('t2', { owner_agent_id: 'worker', source: 'live' })],
        has_more: false, next_page_token: undefined,
        coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      }),
    ];
    let call = 0;
    await renderWith(async () => pages[Math.min(call++, pages.length - 1)]!);
    expect(connectionClient.listAgentTasks).toHaveBeenCalledTimes(2);
    // The second page carried a token, and both rows are on screen.
    expect(connectionClient.listAgentTasks.mock.calls[1]?.[1]).toMatchObject({ page_token: 'cursor-1' });
    expect(q('[data-cockpit-task="t1"]')).toBeTruthy();
    expect(q('[data-cockpit-task="t2"]')).toBeTruthy();
  });

  it('marks a persisted owner as recorded rather than live, and says so in the mark', async () => {
    await renderWith(async () => page({
      items: [task('t-cold', { owner_agent_id: 'lead', source: 'persisted' })],
      owners: [{ owner_agent_id: 'lead', source: 'persisted', state: 'complete' }],
      coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    }));
    const row = q('[data-cockpit-task="t-cold"]');
    expect(row?.getAttribute('data-task-source')).toBe('persisted');
    // A cold record is drawn hollow, not as a live running bar.
    expect(row?.querySelector('[data-cockpit-task-span]')?.className).toContain('border-dashed');
  });

  it('reports a failed read instead of an empty session', async () => {
    await renderWith(async () => { throw new Error('network down'); });
    const note = q('[data-cockpit-task-read="failed"]');
    expect(note).toBeTruthy();
    // And it is not claiming the session has no background work.
    expect(note?.getAttribute('role')).toBe('status');
  });

  it('restarts from the first page when the cursor goes stale, and keeps the rows it then reads', async () => {
    let call = 0;
    await renderWith(async () => {
      call += 1;
      if (call === 1) {
        return page({
          items: [task('t1', { owner_agent_id: 'lead', source: 'live' })],
          has_more: true, next_page_token: 'stale-cursor',
          coverage: { total_owners: 3, completed_owners: 1, failed_owners: 0, pending_owners: 2, inventory_complete: true, complete: false, failures: [] },
        });
      }
      if (call === 2) throw Object.assign(new Error('restart pagination'), { code: 40001 });
      return page({
        items: [task('t1', { owner_agent_id: 'lead', source: 'live' }), task('t2', { owner_agent_id: 'worker', source: 'live' })],
        has_more: false, next_page_token: undefined,
        coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      });
    });
    // Three calls: page, stale cursor, then a fresh first page.
    expect(connectionClient.listAgentTasks).toHaveBeenCalledTimes(3);
    expect(connectionClient.listAgentTasks.mock.calls[2]?.[1]).not.toHaveProperty('page_token');
    expect(q('[data-cockpit-task="t2"]')).toBeTruthy();
    expect(q('[data-cockpit-task-read="partial"]')).toBeNull();
  });

  it('shows what is known when a continuation page fails, rather than clearing the list', async () => {
    let call = 0;
    await renderWith(async () => {
      call += 1;
      if (call === 1) {
        return page({
          items: [task('t1', { owner_agent_id: 'lead', source: 'live' })],
          has_more: true, next_page_token: 'cursor-1',
          coverage: { total_owners: 3, completed_owners: 1, failed_owners: 0, pending_owners: 2, inventory_complete: true, complete: false, failures: [] },
        });
      }
      throw new Error('boom');
    });
    expect(q('[data-cockpit-task="t1"]')).toBeTruthy();
    expect(q('[data-cockpit-task-read="partial"]')).toBeTruthy();
  });

  it('recovers when a failed read is asked again, from the first page', async () => {
    // A read that fails once and then answers is the case the retry exists
    // for. Recovery must re-run the whole walk rather than resume the dead
    // cursor, so the second call carries no page_token.
    let call = 0;
    connectionClient.listAgentTasks.mockReset();
    connectionClient.listAgentTasks.mockImplementation((async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return page({
        items: [task('t-after', { owner_agent_id: 'worker', source: 'live' })],
        coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      });
    }) as never);
    await render({ forest: FLEET });
    expect(q('[data-cockpit-task-read="failed"]')).toBeTruthy();
    // The control has to exist, or a failed read is a dead end.
    const retry = q('[data-cockpit-task-retry]');
    expect(retry).toBeTruthy();

    await act(async () => {
      (retry as HTMLElement).click();
    });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

    expect(q('[data-cockpit-task-read="failed"]')).toBeNull();
    expect(q('[data-cockpit-task="t-after"]')).toBeTruthy();
    expect(connectionClient.listAgentTasks).toHaveBeenCalledTimes(2);
    expect(connectionClient.listAgentTasks.mock.calls[1]?.[1]).not.toHaveProperty('page_token');
  });

  it('names a task owner with the tree label, and falls back to the id', async () => {
    await renderWith(async () => page({
      items: [
        task('t-named', { owner_agent_id: 'worker', source: 'live' }),
        // An owner the tree has no node for: naming one would invent it.
        task('t-orphan', { owner_agent_id: 'agent-gone', source: 'live' }),
      ],
      owners: [
        { owner_agent_id: 'worker', source: 'live', state: 'complete' },
        { owner_agent_id: 'agent-gone', source: 'live', state: 'complete' },
      ],
      coverage: { total_owners: 2, completed_owners: 2, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    }));
    expect(q('[data-cockpit-task="t-named"] [data-task-owner-label]')?.textContent).toBe('API worker 2');
    expect(q('[data-cockpit-task="t-orphan"] [data-task-owner-label]')?.textContent).toBe('agent-gone');
  });

  it('marks a cold persisted running task as recorded rather than running', async () => {
    await renderWith(async () => page({
      items: [task('t-cold', { owner_agent_id: 'worker', source: 'persisted' })],
      owners: [{ owner_agent_id: 'worker', source: 'persisted', state: 'complete' }],
      coverage: { total_owners: 1, completed_owners: 1, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    }));
    const row = q('[data-cockpit-task="t-cold"]');
    expect(row?.getAttribute('data-task-state')).toBe('running');
    expect(row?.getAttribute('data-task-source')).toBe('persisted');
    // The mark is the distinction: a live running task wears the filled dot
    // (`data-life="working"`), and a cold one must not.
    expect(row?.querySelector('[data-life="working"]')).toBeNull();
    // The bar is hollow, and the row says which kind of owner it is.
    expect(row?.querySelector('[data-cockpit-task-span]')?.className).toContain('border-dashed');
    expect(row?.getAttribute('title')).toContain('recorded, not running');
  });

  it('keeps a live running task on the filled mark, so cold is the exception', async () => {
    await renderWith(async () => page({
      items: [task('t-live', { owner_agent_id: 'worker', source: 'live' })],
      owners: [{ owner_agent_id: 'worker', source: 'live', state: 'complete' }],
      coverage: { total_owners: 1, completed_owners: 1, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    }));
    const row = q('[data-cockpit-task="t-live"]');
    expect(row?.querySelector('[data-life="working"]')).toBeTruthy();
    expect(row?.querySelector('[data-cockpit-task-span]')?.className).not.toContain('border-dashed');
  });

  it('does not claim a read limit the server does not have', async () => {
    // `inventory_complete: false` means the server could not list every owner.
    // The read itself has no cap, so the copy must not say the work "exceeds
    // one read": that would invent a limit to explain a different problem.
    await renderWith(async () => page({
      coverage: { total_owners: 2, completed_owners: 2, failed_owners: 0, pending_owners: 0, inventory_complete: false, complete: false, failures: [] },
    }));
    const note = q('[data-cockpit-task-read="inventory"]');
    expect(note).toBeTruthy();
    expect(note?.textContent ?? '').not.toMatch(/one read|budget|cap/i);
    expect(note?.textContent).toContain('could not list every agent');
  });

  it('separates a failed owner read from an incomplete inventory', async () => {
    // `partial` with a failed owner is missing work, which is not the same
    // problem as not knowing how many owners there are.
    await renderWith(async () => page({
      partial: true,
      coverage: { total_owners: 3, completed_owners: 2, failed_owners: 1, pending_owners: 0, inventory_complete: true, complete: false, failures: [] },
    }));
    const note = q('[data-cockpit-task-read="read-failed"]');
    expect(note).toBeTruthy();
    expect(q('[data-cockpit-task-read="inventory"]')).toBeNull();
    expect(note?.textContent).toContain('1 agents');
  });

  it('keeps the branch count stable when a branch is expanded', async () => {
    // Counting the rows on screen made the header drop when a branch was
    // opened, because expanding replaces a branch row with that branch plus
    // its agents. The count is the tree's, not the view's.
    const wide = forestOf([
      node(MAIN_AGENT_ID, { childIds: ['lead', 'tests'] }),
      node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, childIds: ['worker'] }),
      node('worker', { label: 'API worker 2', parentAgentId: 'lead' }),
      node('tests', { label: 'Tests', parentAgentId: MAIN_AGENT_ID }),
    ]);
    connectionClient.listAgentTasks.mockReset();
    connectionClient.listAgentTasks.mockImplementation((async () => page()) as never);
    await render({ forest: wide });
    const folded = q('[data-cockpit-graph] header')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(folded).toContain('2 branches');
    expect(all('[data-cockpit-branch]')).toHaveLength(2);
    expect(all('[data-cockpit-lane]')).toHaveLength(0);

    await render({ expandedBranches: new Set(['lead']) });
    // Expanding a branch replaces its row with that branch's agents, so the
    // row count on screen drops from two branches to one. The header count is
    // the tree's, so it must not move with the view. (The header also grows a
    // "Fold all" control once something is open, which is why the count is
    // compared on its own rather than as whole-header text.)
    expect(all('[data-cockpit-branch]')).toHaveLength(1);
    expect(all('[data-cockpit-lane]').length).toBeGreaterThan(0);
    const expanded = q('[data-cockpit-graph] header')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(expanded).toContain('2 branches');
  });

  it('gives every row kind the same axis hook, so one timestamp is one line', async () => {
    // jsdom has no layout engine, so it cannot measure pixels. What it can
    // prove is the structural half of CF-01: all four row kinds and both
    // overlays expose one axis hook, so a single browser measurement can
    // compare them at one timestamp. The measured half is the browser
    // capture's `axisGeometry` assertion.
    connectionClient.listAgentTasks.mockReset();
    connectionClient.listAgentTasks.mockImplementation((async () => page({
      items: [task('t1', { owner_agent_id: 'lead', source: 'live' })],
      coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
    })) as never);
    // One branch open, so the frame carries all four row kinds at once.
    await render({
      forest: forestOf([
        node(MAIN_AGENT_ID, { childIds: ['lead', 'tests'] }),
        node('lead', { label: 'API lead', parentAgentId: MAIN_AGENT_ID, childIds: ['worker'] }),
        node('worker', { label: 'API worker 2', parentAgentId: 'lead' }),
        node('tests', { label: 'Tests', parentAgentId: MAIN_AGENT_ID }),
      ]),
      expandedBranches: new Set(['lead']),
    });
    expect(all('[data-cockpit-axis="main"]').length).toBe(1);
    expect(all('[data-cockpit-axis="branch"]').length).toBeGreaterThan(0);
    expect(all('[data-cockpit-axis="agent"]').length).toBeGreaterThan(0);
    expect(all('[data-cockpit-axis="task"]').length).toBe(1);
    expect(all('[data-cockpit-axis="grid"]').length).toBe(1);
    expect(all('[data-cockpit-axis="tick"]').length).toBe(1);
  });
});
