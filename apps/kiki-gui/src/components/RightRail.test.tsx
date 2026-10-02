// @vitest-environment jsdom

import { act, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import { buildAgentForest, createViewState, type ApprovalBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { RightRail, type SubagentRailContext } from './RightRail';
import { PreviewFocusBridge } from './SessionView';
import { useInspectorFocusTracking } from './inspectorFocus';

// The profile head and capability block read the agent panel over the
// connection; these fixtures have none, so they render as plain stand-ins.
vi.mock('./rail-variants/DefaultSections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rail-variants/DefaultSections')>()),
  ProfileHead: ({ label }: { label: string }) => <div data-rail-profile-head>{label}</div>,
  CapabilitiesBlock: () => null,
}));

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: ({ part = 'all', agentId, overviewMode, renderOverview }: {
    part?: string; agentId: string; overviewMode?: string;
    renderOverview?: (body: React.ReactNode, scopeSwitch: React.ReactNode) => React.ReactNode;
  }) => {
    const body = <div data-panel-props={part} data-panel-agent={agentId} data-panel-mode={overviewMode} />;
    return renderOverview === undefined ? body : renderOverview(body, overviewMode === 'cockpit' ? null : <div data-usage-scope-switch />);
  },
}));

const forest = buildAgentForest([], [
  { agentId: 'main', name: 'Main' },
  { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
]);
const context: SubagentRailContext = {
  agentId: 'agent-1',
  block: undefined,
  pendingInteractionCount: 1,
  onJumpToSpawn: () => {},
};
const tasks: Task[] = [
  {
    id: 'background-1', session_id: 'sess-1', kind: 'bash', description: 'Dev server',
    status: 'running', created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'subagent-1', session_id: 'sess-1', kind: 'subagent', agent_id: 'agent-1',
    description: 'Researcher', status: 'running', created_at: '2026-01-01T00:01:00.000Z',
  },
];
const mounts: { container: HTMLDivElement; root: Root }[] = [];
const pendingApproval: ApprovalBlock = {
  kind: 'approval',
  id: 'approval-r1',
  request: {
    approval_id: 'r1', session_id: 'sess-1', tool_call_id: 'c1', tool_name: 'Bash', action: 'Run: ls', tool_input_display: undefined,
    created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z',
  },
  resolution: undefined,
  originAgentId: 'agent-1',
};
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-subagent-scroll') || this.hasAttribute('data-subagents-all-scroll') ? 320 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const { container, root } of mounts.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderRail({
  subagent,
  empty = false,
  stateTasks,
  ownerAgentId,
  agentForest,
  onClose,
  onInspectMain,
  onOpenSubagent,
  sessionPending,
  onResolveApproval,
}: {
  sessionPending?: readonly ApprovalBlock[];
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  subagent?: SubagentRailContext;
  empty?: boolean;
  agentForest?: ReturnType<typeof buildAgentForest>;
  onClose?: () => void;
  onInspectMain?: () => void;
  onOpenSubagent?: (agentId: string) => void;
  /** Main-session tasks; the child-only set arrives via `subagent`'s tasks. */
  stateTasks?: readonly Task[];
  /** Rail cancel/detail owner scope (the focused agent's task service). */
  ownerAgentId?: string;
} = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={{ ...createViewState('sess-1'), tasks: (empty ? [] : stateTasks) ?? tasks }}
            forest={agentForest ?? (empty ? buildAgentForest([], [{ agentId: 'main', name: 'Main' }]) : forest)}
            selectedAgentId={subagent?.agentId}
            subagent={subagent}
            taskOwnerAgentId={ownerAgentId}
            onCancelTask={() => {}}
            onStopAgentTask={async () => {}}
            onOpenSubagent={onOpenSubagent ?? (() => {})}
            onClose={onClose}
            onInspectMain={onInspectMain}
            sessionPending={sessionPending}
            onResolveApproval={onResolveApproval}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

/** Data-driven chapters: the fixed sections between the pinned head and the folded tail. */
function sharedChapters(container: Element) {
  return [...container.querySelectorAll<HTMLElement>('[data-agent-panel-scroll] > .rail-page > div > section:not([data-inspector-now])')]
    .map((section) => ({
      title: section.querySelector(':scope > div span.font-medium')?.textContent,
      className: section.className,
    }));
}

describe('RightRail fixed and switchable parts', () => {
  /** Every rail part outside the overview block, as data hooks, in page order. */
  function fixedParts(rail: Element) {
    const hooks = ['data-rail-owner', 'data-rail-profile-head', 'data-inspector-now', 'data-inspector-needs-you', 'data-inspector-agents', 'data-inspector-tail'];
    return hooks.filter((hook) => {
      const node = rail.querySelector(`[${hook}]`);
      return node !== null && node.closest('[data-rail-switchable]') === null;
    });
  }
  async function choose(rail: Element, mode: 'default' | 'cockpit') {
    await act(async () => { rail.querySelector<HTMLButtonElement>(`[data-rail-mode="${mode}"]`)!.click(); });
  }
  afterEach(() => { localStorage.removeItem('kiki.railMode'); });

  it('keeps every fixed part, the agents section included, in both modes', async () => {
    const rail = await renderRail({ sessionPending: [pendingApproval] });
    const standard = fixedParts(rail);
    const standardHtml = [...rail.querySelectorAll('[data-inspector-agents], [data-rail-profile-head]')].map((node) => node.outerHTML);
    await choose(rail, 'cockpit');
    expect(fixedParts(rail)).toEqual(standard);
    expect(standard).toContain('data-inspector-agents');
    // Same place, same markup: the agents section does not change with the mode.
    expect([...rail.querySelectorAll('[data-inspector-agents], [data-rail-profile-head]')].map((node) => node.outerHTML)).toEqual(standardHtml);
  });

  it('switches only the overview block, from a switch in the rail head', async () => {
    const rail = await renderRail();
    const switcher = rail.querySelector('[data-rail-mode-switch]')!;
    // The switch heads the rail (always visible); the overview head carries
    // no switch of its own, and the block below is still the only thing that
    // follows the mode.
    expect(switcher.closest('[data-rail-pinned]')).not.toBeNull();
    expect(switcher.closest('[data-rail-owner]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-switchable-head] [data-rail-mode-switch]')).toBeNull();
    const zone = () => rail.querySelector('[data-rail-switchable]')!;
    const outside = () => [...rail.querySelectorAll('[data-agent-panel-scroll] > .rail-page > *')]
      .filter((node) => !node.hasAttribute('data-rail-switchable'))
      .map((node) => node.outerHTML);
    expect(zone().getAttribute('data-rail-switchable')).toBe('default');
    expect(zone().querySelector('[data-panel-props="overview"]')?.getAttribute('data-panel-mode')).toBe('default');
    const before = outside();
    await choose(rail, 'cockpit');
    expect(zone().getAttribute('data-rail-switchable')).toBe('cockpit');
    expect(zone().querySelector('[data-panel-props="overview"]')?.getAttribute('data-panel-mode')).toBe('cockpit');
    expect(outside()).toEqual(before);
    expect(localStorage.getItem('kiki.railMode')).toBe('cockpit');
  });

  it('keeps the overview flat in both modes without removing the chapter spacing', async () => {
    const rail = await renderRail();
    for (const mode of ['default', 'cockpit'] as const) {
      await choose(rail, mode);
      const well = rail.querySelector('[data-rail-overview-well]')!;
      expect(well.className).not.toMatch(/(?:^|\s)(?:rounded|bg|border|ring|shadow)(?:-|\s|$)/);
      expect(well.querySelector('#rail-overview-title')).not.toBeNull();
      expect(well.querySelector<HTMLElement>('[data-panel-props="overview"]')?.dataset['panelMode']).toBe(mode);
      expect(well.closest('[data-rail-switchable]')?.classList.contains('py-4')).toBe(true);
    }
  });

  it('places the overview scope beside its title and usage link, outside the controlled body', async () => {
    const rail = await renderRail();
    const head = rail.querySelector('[data-rail-switchable-head]')!;
    expect(head.querySelector('#rail-overview-title')).not.toBeNull();
    expect(head.querySelector('[data-rail-open-usage]')).not.toBeNull();
    expect(head.querySelector('[data-usage-scope-switch]')).not.toBeNull();
    expect(head.classList.contains('items-baseline')).toBe(true);
    expect(head.classList.contains('flex-nowrap')).toBe(true);
    expect(head.querySelector('#rail-overview-title')?.classList.contains('whitespace-nowrap')).toBe(true);
    expect(rail.querySelector('#rail-overview-body [data-usage-scope-switch]')).toBeNull();
    await choose(rail, 'cockpit');
    expect(rail.querySelector('[data-rail-switchable-head] #rail-overview-title')).not.toBeNull();
    expect(rail.querySelector('[data-usage-scope-switch]')).toBeNull();
  });

  it('lifts the overview into view only when cockpit is chosen with the block outside the viewport', async () => {
    const rail = await renderRail();
    const slot = rail.querySelector<HTMLElement>('[data-rail-agent-panel-slot]')!;
    const scroller = rail.querySelector<HTMLElement>('[data-agent-panel-scroll]')!;
    // jsdom has no scrollIntoView; the rail guards for that and calls it only
    // when the block actually sits outside the rail's scroll viewport.
    const scrollIntoView = vi.fn();
    Object.assign(slot, { scrollIntoView });
    // Zero rects in jsdom read as fully visible: choosing cockpit does not scroll.
    await choose(rail, 'cockpit');
    expect(scrollIntoView).not.toHaveBeenCalled();
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const slotRect = vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue(rect(1200, 1500));
    const scrollerRect = vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 900));
    // Choosing the standard mode never scrolls…
    await choose(rail, 'default');
    expect(scrollIntoView).not.toHaveBeenCalled();
    // …but with the block below the fold, choosing cockpit lifts it into view.
    await choose(rail, 'cockpit');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    slotRect.mockRestore();
    scrollerRect.mockRestore();
  });

  it('renders the main agent and a subagent with the same rail, each from its own agent', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });
    const shape = (rail: Element) => ['[data-rail-owner]', '[data-rail-now-block]', '#rail-todos', '[data-rail-switchable]', '[data-inspector-tail]']
      .map((selector) => rail.querySelectorAll(selector).length);
    // One component: the page is built from the same blocks.
    expect(shape(child)).toEqual([1, 1, 1, 1, 1]);
    expect(shape(main)).toEqual(shape(child));
    expect(main.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent')).toBe('main');
    expect(child.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent')).toBe('agent-1');
    for (const part of ['work', 'overview']) {
      expect(main.querySelector(`[data-panel-props="${part}"]`)?.getAttribute('data-panel-agent')).toBe('main');
      expect(child.querySelector(`[data-panel-props="${part}"]`)?.getAttribute('data-panel-agent')).toBe('agent-1');
    }
    expect(main.querySelector('[data-rail-profile-head]')?.textContent).toBe('Main');
    expect(child.querySelector('[data-rail-profile-head]')?.textContent).toBe('Researcher');
    // Main-only and subagent-only parts follow railVisibility, not a second component.
    expect(main.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
    expect(child.querySelector('[data-terminate-all-subagents]')).toBeNull();
    expect(main.querySelector('[data-rail-locate]')).toBeNull();
    expect(child.querySelector('[data-rail-locate]')).not.toBeNull();
  });
});

describe('RightRail shared chapters', () => {
  it('mounts the agent panel only when its rail slot enters the viewport', async () => {
    let notify: IntersectionObserverCallback | undefined;
    const originalObserver = globalThis.IntersectionObserver;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    try {
      const rail = await renderRail();
      // Todo / plan read live state only and mount at once; the overview
      // (which starts the capability read) waits for its slot to scroll in.
      expect(rail.querySelector('[data-panel-props="work"]')).not.toBeNull();
      expect(rail.querySelector('[data-panel-props="overview"]')).toBeNull();
      expect(rail.querySelectorAll('#rail-overview-title')).toHaveLength(1);
      expect(rail.querySelector('[data-rail-switchable-head] [data-rail-open-usage]')).not.toBeNull();
      await act(async () => {
        notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(rail.querySelector('[data-panel-props="overview"]')).not.toBeNull();
      expect(rail.querySelectorAll('#rail-overview-title')).toHaveLength(1);
      const mounted = mounts[0];
      await act(async () => { mounted?.root.unmount(); });
      mounts.shift();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.stubGlobal('IntersectionObserver', originalObserver);
    }
  });

  it('names the page owner with a breadcrumb in both focus states', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });

    const mainOwner = main.querySelector('[data-rail-owner]');
    expect(mainOwner?.querySelector('[aria-current="page"]')?.textContent).toContain('Main agent');
    expect(mainOwner?.querySelector('[data-inspect-main]')).toBeNull();
    expect(mainOwner?.getAttribute('data-rail-owner-name')).toBeNull();
    // A subagent page: "Main agent / Researcher", main a step back up.
    const childOwner = child.querySelector('[data-rail-owner]');
    expect(childOwner?.getAttribute('data-rail-owner-name')).toBe('Researcher');
    expect(childOwner?.querySelector('[aria-current="page"]')?.textContent).toContain('Researcher');
    expect(childOwner?.querySelector('[data-inspect-main]')?.textContent).toBe('Main agent');
    // The pinned head leads the scroll content in both focus states.
    for (const rail of [main, child]) {
      const head = rail.querySelector('[data-agent-panel-scroll]')?.firstElementChild;
      expect(head?.hasAttribute('data-rail-pinned')).toBe(true);
      expect(head?.firstElementChild?.hasAttribute('data-rail-owner')).toBe(true);
    }
  });

  it('keeps an accessible rail-close action at the end of the head', async () => {
    const onClose = vi.fn();
    const rail = await renderRail({ subagent: context, onClose });
    const close = rail.querySelector<HTMLButtonElement>('[data-rail-close]');
    expect(close?.closest('[data-rail-owner]')).not.toBeNull();
    expect(close?.closest('nav')).toBeNull();
    expect(close?.getAttribute('aria-label')).toBe('Hide panel');
    expect(close?.className).toContain('h-11');
    expect(close?.className).toContain('lg:h-7');
    await act(async () => { close?.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lists only the focused agent own tasks in the child-focus task bar', async () => {
    // SessionView hands the rail only the focused agent's own task set when a
    // panel tab is focused: main-session tasks stay out (their stop/detail
    // would hit the wrong task service), subagent-kind rows stay out of the
    // background-task list, and the owner scope is the focused agent.
    const childTasks: Task[] = [
      {
        id: 'child-bash-1', session_id: 'sess-1', kind: 'bash',
        description: 'Focused agent dev server',
        status: 'running', created_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    const mainTasks: Task[] = [
      {
        id: 'background-1', session_id: 'sess-1', kind: 'bash', description: 'Dev server',
        status: 'running', created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    // SessionView's projection: the rail state carries ONLY the child set.
    const rail = await renderRail({
      subagent: context,
      stateTasks: childTasks,
      ownerAgentId: context.agentId,
    });

    // The focused agent's own task listed; the main task never mixed in.
    expect(rail.querySelector('[data-task-open="child-bash-1"]')).not.toBeNull();
    expect(rail.querySelector('[data-task-open="background-1"]')).toBeNull();
    expect(rail.querySelector('[data-task-open="subagent-1"]')).toBeNull();

    // Main focus keeps the session-wide set: the main task is listed.
    const main = await renderRail({ stateTasks: mainTasks });
    expect(main.querySelector('[data-task-open="background-1"]')).not.toBeNull();
  });

  it('keeps the team, background tasks and bulk stop on main, and the focused agent page on a subagent', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });

    expect(sharedChapters(main).map((chapter) => chapter.title)).toEqual(['Agents', 'Background tasks']);
    expect(sharedChapters(child).map((chapter) => chapter.title)).toEqual(['Background tasks']);
    // Main's team: one row per subagent, content under the name.
    expect(main.querySelector('[data-agent-tree] [data-agent-id="agent-1"]')).not.toBeNull();
    expect(main.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-tasks-scroll] [data-task-open="background-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-task-open="subagent-1"]')).toBeNull();
      expect(rail.querySelector('[data-panel-props]')).not.toBeNull();
    }
    expect(main.querySelector('[data-subagent-context]')).toBeNull();
    // The focused subagent: Now says its state (waiting on the user here) and
    // offers its own controls; the team roster stays on main's page.
    const now = child.querySelector('[data-inspector-now]');
    expect(now?.querySelector('[data-needs-input]')).not.toBeNull();
    expect(now?.textContent).toContain('Needs you');
    expect(child.querySelector('[data-subagent-context] [data-rail-locate]')).not.toBeNull();
    expect(child.querySelector('[data-agent-tree]')).toBeNull();
    // Reading order: the pinned profile head and Now, then the agent's own
    // checklist, its tasks, context and cost, and the folded tail.
    const scroll = child.querySelector('[data-agent-panel-scroll]')!;
    expect(scroll.querySelector('[data-inspector-setup]')).toBeNull();
    const order = [
      scroll.querySelector('[data-rail-profile-head]'),
      now,
      scroll.querySelector('[data-panel-props="work"]'),
      scroll.querySelector('[data-tasks-scroll]'),
      scroll.querySelector('[data-rail-agent-panel-slot]'),
      scroll.querySelector('[data-inspector-tail]'),
    ];
    expect(order.every((node) => node !== null)).toBe(true);
    for (let index = 1; index < order.length; index += 1) {
      const before = order[index - 1]!;
      const after = order[index]!;
      expect(before === after || (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    }
    // Every slice describes the focused agent.
    for (const slice of child.querySelectorAll('[data-panel-props]')) {
      expect(slice.getAttribute('data-panel-agent')).toBe('agent-1');
    }
  });

  it('turns back to main from the crumb, and keeps the way up for a nested agent', async () => {
    const onInspectMain = vi.fn();
    const child = await renderRail({ subagent: context, onInspectMain });
    const back = child.querySelector<HTMLButtonElement>('[data-rail-owner] [data-inspect-main]');
    expect(back?.getAttribute('title')).toBe('Inspect the main agent');
    await act(async () => { back?.click(); });
    expect(onInspectMain).toHaveBeenCalledTimes(1);
    expect(child.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent')).toBe('agent-1');

    const deep = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
      { agentId: 'agent-1a', parentAgentId: 'agent-1', name: 'Reader', status: 'running' },
    ]);
    const opened: string[] = [];
    // The routed agent page has no onInspectMain: a crumb navigates instead.
    const nested = await renderRail({
      agentForest: deep,
      onOpenSubagent: (agentId) => { opened.push(agentId); },
      subagent: { agentId: 'agent-1a', block: undefined, pendingInteractionCount: 0, onJumpToSpawn: undefined },
    });
    const owner = nested.querySelector('[data-rail-owner]')!;
    expect(owner.textContent).toContain('Main agent');
    const crumb = owner.querySelector<HTMLButtonElement>('[data-inspect-parent]');
    expect(crumb?.textContent).toBe('Researcher');
    await act(async () => { crumb?.click(); });
    expect(opened).toEqual(['agent-1']);
    // A direct child of main needs no extra crumb: main already is the step up.
    const shallow = await renderRail({ subagent: context, onInspectMain: () => {} });
    expect(shallow.querySelector('[data-inspect-parent]')).toBeNull();
  });

  it('leads with the profile head and folds only the session row', async () => {
    const rail = await renderRail();
    const page = rail.querySelector('[data-rail-pinned] .rail-page')!;
    expect(page.firstElementChild?.hasAttribute('data-rail-profile-head')).toBe(true);
    expect(rail.querySelector('[data-inspector-setup]')).toBeNull();
    const session = rail.querySelector('[data-inspector-session]');
    expect(session === null || session.querySelector('[aria-expanded="false"]') !== null).toBe(true);
  });

  it('keeps the resident overview in every state, idle and empty included', async () => {
    for (const subagent of [undefined, context]) {
      const empty = await renderRail({ subagent, empty: true });
      expect(sharedChapters(empty).map((chapter) => chapter.title)).toEqual([]);
      expect(empty.querySelector('[data-rail-agent-panel-slot]')).not.toBeNull();
      expect(empty.querySelector('[data-subagent-context]') !== null).toBe(subagent !== undefined);
    }
    // The agent roster and tasks are fixed chapters: a label, no fold.
    const populated = await renderRail();
    const roster = populated.querySelector('[data-inspector-agents]');
    expect(roster?.querySelector(':scope > div > [aria-expanded]')).toBeNull();
  });

  it('windows a large roster, folds ended agents and never sets failures apart', async () => {
    const large = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      ...Array.from({ length: 511 }, (_, index) => ({
        agentId: `child-${index}`, parentAgentId: 'main', name: `Child ${index}`,
        status: (index % 50 === 0 ? 'failed' : index < 60 ? 'running' : 'completed') as 'failed' | 'running' | 'completed',
      })),
    ]);
    const rail = await renderRail({ agentForest: large });
    const rows = rail.querySelectorAll('[data-agent-tree] [data-agent-id]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    expect(rail.querySelector('[data-roster-done-group]')?.textContent).toContain('finished');
    expect(rail.querySelector('[data-roster-search]')).not.toBeNull();
    // No failed filter, no red: a failure ended like any other agent.
    expect(rail.querySelector('[data-roster-filter="failed"]')).toBeNull();
    expect(rail.querySelector('[data-agent-tree] .text-danger')).toBeNull();
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-roster-filter="running"]')!.click(); });
    const running = [...rail.querySelectorAll<HTMLElement>('[data-agent-tree] [data-agent-id]')];
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((row) => row.dataset['rosterBucket'] === 'running')).toBe(true);
  });

  it('bubbles nested approvals to the top with their trail and decides them in place', async () => {
    const deep = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      { agentId: 'lead', parentAgentId: 'main', name: 'Lead', status: 'running' },
      { agentId: 'worker', parentAgentId: 'lead', name: 'Worker', status: 'suspended' },
    ]);
    const approval: ApprovalBlock = {
      kind: 'approval',
      id: 'approval-a1',
      request: {
        approval_id: 'a1', session_id: 'sess-1', tool_call_id: 'c1', tool_name: 'Bash', action: 'Run: ls',
        tool_input_display: { kind: 'command', command: 'ls -la' }, created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z',
      },
      resolution: undefined,
      originAgentId: 'worker',
    };
    const decided: string[] = [];
    const rail = await renderRail({
      agentForest: deep,
      sessionPending: [approval],
      onResolveApproval: async (id, decision) => { decided.push(`${id}:${decision}`); },
    });
    const block = rail.querySelector('[data-inspector-needs-you]')!;
    // The row names who asked; the full trail rides its title.
    expect(block.querySelector('[data-needs-you-from="worker"]')?.getAttribute('title')).toBe('Lead › Worker');
    // It sits above the team, under the pinned Now.
    expect(rail.querySelector('[data-inspector-now]')!.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.compareDocumentPosition(rail.querySelector('[data-inspector-agents]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-needs-you-approve="a1"]')!.click(); });
    expect(decided).toEqual(['a1:approved']);
    // The lead's folded row says a descendant waits.
    expect(rail.querySelector('[data-agent-id="lead"]')?.textContent).toContain('1 needs you below');
  });

  it('opens a roster row through the timeline open handler', async () => {
    const opened: string[] = [];
    const onInspectMain = vi.fn();
    const rail = await renderRail({ onOpenSubagent: (agentId) => { opened.push(agentId); }, onInspectMain });
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-agent-tree] [data-agent-id="agent-1"]')!.click(); });
    // The same handler the timeline card uses (SessionView.openAgent): the
    // preview opens, and the rail does not turn to the agent on its own.
    expect(opened).toEqual(['agent-1']);
    expect(onInspectMain).not.toHaveBeenCalled();
  });
});

describe('opening a subagent: timeline card and rail are one entry', () => {
  // The session view's wiring, reduced to what an open depends on: the
  // document-level inspector tracker pins the rail to the pressed agent, and
  // the timeline card and every rail entry call the same openAgent.
  function Harness({ openAgent, sessionPending }: {
    openAgent: (agentId: string) => void;
    sessionPending: readonly ApprovalBlock[];
  }) {
    const [pinned, setPinned] = useState<string | undefined>(undefined);
    useInspectorFocusTracking({ onPin: setPinned, isKnown: (id) => familyForest.byId[id] !== undefined });
    // An opened agent tab turns the rail to it (PreviewFocusBridge).
    const open = (agentId: string) => { openAgent(agentId); setPinned(agentId); };
    return (
      <>
        <div className="conversation-center">
          <div data-subagent-id="worker">
            <button type="button" data-agent-open="worker" onClick={() => { open('worker'); }}>Worker</button>
          </div>
        </div>
        <RightRail
          state={createViewState('sess-1')}
          forest={familyForest}
          selectedAgentId={pinned}
          subagent={pinned === undefined ? undefined : { agentId: pinned, block: undefined, pendingInteractionCount: 0, onJumpToSpawn: undefined }}
          onCancelTask={() => {}}
          onOpenSubagent={open}
          onInspectMain={() => { setPinned(undefined); }}
          sessionPending={sessionPending}
        />
      </>
    );
  }
  const familyForest = buildAgentForest([], [
    { agentId: 'main', name: 'Main' },
    { agentId: 'worker', parentAgentId: 'main', name: 'Worker', status: 'suspended' },
  ]);
  const pendingFromWorker: ApprovalBlock = {
    kind: 'approval',
    id: 'approval-w1',
    request: {
      approval_id: 'w1', session_id: 'sess-1', tool_call_id: 'c1', tool_name: 'Bash', action: 'Run: ls', tool_input_display: undefined,
      created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
    originAgentId: 'worker',
  };

  /** A real press: pointerdown, pointerup, click, with the focus a click gives
   * (jsdom has no PointerEvent; the tracker reads only `button`).
   * A browser runs a microtask checkpoint between the listeners of a
   * user-initiated event, so an update a capture listener schedules renders
   * before the control's own onClick. A script-dispatched event has no such
   * checkpoint; the flushSync listener stands in for it (without it, a pin
   * that remounts the pressed control would pass here and fail in use). */
  async function press(element: HTMLElement) {
    const checkpoint = () => { flushSync(() => {}); };
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, checkpoint, true);
      try {
        element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        element.focus();
        element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      } finally {
        for (const type of ['pointerdown', 'pointerup', 'click']) document.removeEventListener(type, checkpoint, true);
      }
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }

  async function openFrom(entry: 'timeline' | 'roster' | 'needs-you') {
    const opened: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <Harness openAgent={(id) => { opened.push(id); }} sessionPending={[pendingFromWorker]} />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    const selector = {
      timeline: '[data-agent-open="worker"]',
      roster: '[data-agent-tree] [data-agent-id="worker"]',
      'needs-you': '[data-needs-you-from="worker"]',
    }[entry];
    const target = () => container.querySelector<HTMLElement>(selector)!;
    await press(target());
    const first = { opened: [...opened], rail: container.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent') };
    const focusOnBody = document.activeElement === document.body;
    // Pressing it again, where the turned page still shows it (a roster row
    // moves off: Worker's own page lists Worker's children, not Worker).
    const stillThere = target() !== null;
    if (stillThere) await press(target());
    return { first, again: stillThere ? [...opened] : undefined, focusOnBody };
  }

  it('opens the same agent with the same call and the same rail from every entry', async () => {
    const timeline = await openFrom('timeline');
    expect(timeline.first).toEqual({ opened: ['worker'], rail: 'worker' });
    expect(timeline.again).toEqual(['worker', 'worker']);
    expect(timeline.focusOnBody).toBe(false);
    for (const entry of ['roster', 'needs-you'] as const) {
      const rail = await openFrom(entry);
      expect({ entry, ...rail.first }).toEqual({ entry, ...timeline.first });
      if (rail.again !== undefined) expect(rail.again).toEqual(timeline.again);
      // The page turn never drops keyboard focus to <body>.
      expect(rail.focusOnBody).toBe(false);
    }
  });
});
describe('preview focus bridge', () => {
  it('reports the active agent panel tab and hands the rail back on file focus', async () => {
    const seen: Array<string | undefined> = [];
    const onFocusedAgent = (agentId: string | undefined) => { seen.push(agentId); };
    const { MediaPreviewContext } = await import('./mediaPreviewContext');

    // No provider above: the rail stays with the main session.
    const bare = document.createElement('div');
    document.body.append(bare);
    const bareRoot = createRoot(bare);
    await act(async () => { bareRoot.render(<PreviewFocusBridge onFocusedAgent={onFocusedAgent} />); });
    expect(seen).toEqual([undefined]);
    await act(async () => { bareRoot.unmount(); });
    bare.remove();

    // An active agent panel tab retargets the focus at that agent.
    const probe = document.createElement('div');
    document.body.append(probe);
    const probeRoot = createRoot(probe);
    await act(async () => {
      probeRoot.render(
        <MediaPreviewContext.Provider value={{ activeAgentPanelId: 'sub-9' } as never}>
          <PreviewFocusBridge onFocusedAgent={onFocusedAgent} />
        </MediaPreviewContext.Provider>,
      );
    });
    expect(seen.at(-1)).toBe('sub-9');
    await act(async () => { probeRoot.unmount(); });
    probe.remove();

    // A file tab / collapsed panel hands the rail back to main.
    const back = document.createElement('div');
    document.body.append(back);
    const backRoot = createRoot(back);
    await act(async () => {
      backRoot.render(
        <MediaPreviewContext.Provider value={{ activeAgentPanelId: undefined } as never}>
          <PreviewFocusBridge onFocusedAgent={onFocusedAgent} />
        </MediaPreviewContext.Provider>,
      );
    });
    expect(seen.at(-1)).toBeUndefined();
    await act(async () => { backRoot.unmount(); });
    back.remove();
  });
});

describe('inspector focus resolution', () => {
  function tree(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    return host;
  }

  it('maps each agent surface to its agent and leaves unrelated targets alone', async () => {
    const { resolveInspectorTarget } = await import('./inspectorFocus');
    const host = tree(`
      <div class="conversation-center">
        <header><button id="title">t</button></header>
        <div data-agent-workspace-target="main"><p id="prose">p</p>
          <div data-subagent-id="agent-1"><button id="card">c</button></div>
        </div>
      </div>
      <aside data-preview-workspace><section data-preview-tabpanel="panel:agent-2">
        <div data-agent-workspace-target="agent-2"><p id="pane">x</p></div>
      </section><section data-preview-tabpanel="C:/f.ts"><p id="file">f</p></section></aside>
      <aside data-session-rail><button data-agent-id="agent-3" id="node">n</button><p id="railtext">r</p></aside>
    `);
    const at = (id: string) => host.querySelector(`#${id}`);
    expect(resolveInspectorTarget(at('title'))).toBe('main');
    expect(resolveInspectorTarget(at('prose'))).toBe('main');
    expect(resolveInspectorTarget(at('card'))).toBe('agent-1');
    expect(resolveInspectorTarget(at('pane'))).toBe('agent-2');
    expect(resolveInspectorTarget(at('node'))).toBe('agent-3');
    // File previews and the inspector's own prose keep the current pin.
    expect(resolveInspectorTarget(at('file'))).toBeNull();
    expect(resolveInspectorTarget(at('railtext'))).toBeNull();
    expect(resolveInspectorTarget(document.body)).toBeNull();
    host.remove();
  });
});
