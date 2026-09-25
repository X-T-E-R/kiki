// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import { buildAgentForest, createViewState } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { RightRail, type SubagentRailContext } from './RightRail';
import { PreviewFocusBridge } from './SessionView';

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: () => <div data-panel-props />,
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
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-subagent-scroll') || this.hasAttribute('data-subagents-all-scroll') || this.hasAttribute('data-agent-children-nav') ? 320 : 0;
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
}: {
  subagent?: SubagentRailContext;
  empty?: boolean;
  agentForest?: ReturnType<typeof buildAgentForest>;
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
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

function sharedChapters(container: Element) {
  return [...container.querySelectorAll<HTMLElement>('[data-agent-panel-scroll] > section:not([data-subagent-context])')]
    .map((section) => ({
      title: section.querySelector(':scope > div > button > span:last-child')?.textContent,
      className: section.className,
    }));
}

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
      expect(rail.querySelector('[data-panel-props]')).toBeNull();
      await act(async () => {
        notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(rail.querySelector('[data-panel-props]')).not.toBeNull();
      const mounted = mounts[0];
      await act(async () => { mounted?.root.unmount(); });
      mounts.shift();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.stubGlobal('IntersectionObserver', originalObserver);
    }
  });

  it('names the rail owner in both focus states: main agent or the focused subagent', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });

    const mainOwner = main.querySelector('[data-rail-owner]');
    expect(mainOwner).not.toBeNull();
    expect(mainOwner?.textContent).toContain('Main agent');
    const childOwner = child.querySelector('[data-rail-owner]');
    expect(childOwner).not.toBeNull();
    // Focused subagent identity: label, model, and status — not the session title.
    expect(childOwner?.getAttribute('data-rail-owner-name')).toBe('Researcher');
    expect(childOwner?.textContent).toContain('Researcher');
    expect(mainOwner?.getAttribute('data-rail-owner-name')).not.toBe('Researcher');
    // The badge leads the scroll content in both focus states.
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-agent-panel-scroll]')?.firstElementChild?.hasAttribute('data-rail-owner')).toBe(true);
    }
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

  it('renders the same tree, background tasks, bulk subagent stop and session chapters in both modes', async () => {    const main = await renderRail();
    const child = await renderRail({ subagent: context });

    expect(sharedChapters(main)).toEqual(sharedChapters(child));
    expect(sharedChapters(child).map((chapter) => chapter.title)).toEqual([
      'Subagents', 'Background tasks', 'Session',
    ]);
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-agent-tree] [data-agent-id="agent-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-subagent-scroll] + [data-subagents-view-all]')).not.toBeNull();
      expect(rail.querySelector('[data-tasks-scroll] [data-task-open="background-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-task-open="subagent-1"]')).toBeNull();
      expect(rail.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
      expect(rail.querySelector('[data-panel-props]')).not.toBeNull();
    }
    expect(main.querySelector('[data-subagent-context]')).toBeNull();
    const highlight = child.querySelector('[data-subagent-context]');
    expect(highlight?.className).toContain('border-accent/40');
    expect(highlight?.textContent).toContain('Subagent task');
    expect(highlight?.textContent).toContain('Navigate');
    expect(highlight?.querySelector('[data-needs-input]')?.textContent).toContain('1');
    expect(child.querySelector('[data-tasks-scroll]')?.closest('section')?.nextElementSibling).toBe(highlight);
    expect(highlight?.nextElementSibling?.matches('[data-rail-agent-panel-slot]')).toBe(true);
    expect(highlight?.nextElementSibling?.querySelector('[data-panel-props]')).not.toBeNull();
  });

  it('keeps empty chapters hidden and retains collapsible chapter behavior in both modes', async () => {
    for (const subagent of [undefined, context]) {
      const empty = await renderRail({ subagent, empty: true });
      expect(sharedChapters(empty).map((chapter) => chapter.title)).toEqual(['Session']);
      expect(empty.querySelector('[data-subagent-context]') !== null).toBe(subagent !== undefined);

      const populated = await renderRail({ subagent });
      const tree = populated.querySelector('[data-agent-tree]');
      const section = tree?.closest('section');
      const toggle = section?.querySelector<HTMLButtonElement>(':scope > div > button');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      await act(async () => { toggle?.click(); });
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(section?.querySelector('[data-agent-tree]')).toBeNull();
      await act(async () => { toggle?.click(); });
      expect(section?.querySelector('[data-agent-tree]')).not.toBeNull();
    }
  });

  it('bounds mounted agent rows in a large rail and its view-all dialog', async () => {
    const large = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      ...Array.from({ length: 511 }, (_, index) => ({
        agentId: `child-${index}`, parentAgentId: 'main', name: `Child ${index}`, status: 'completed' as const,
      })),
    ]);
    const rail = await renderRail({ agentForest: large });
    const railRows = rail.querySelectorAll('[data-subagent-scroll] [data-agent-id]');
    expect(railRows.length).toBeGreaterThan(0);
    expect(railRows.length).toBeLessThan(25);
    const scroll = rail.querySelector<HTMLDivElement>('[data-subagent-scroll]')!;
    await act(async () => {
      scroll.scrollTop = 52 * 480;
      scroll.dispatchEvent(new Event('scroll'));
    });
    const expectedId = large.byId['main']!.childIds[479];
    expect(scroll.querySelector(`[data-agent-id="${expectedId}"]`)).not.toBeNull();
    expect(scroll.querySelectorAll('[data-agent-id]').length).toBeLessThan(25);
    await act(async () => {
      rail.querySelector<HTMLButtonElement>('[data-subagents-view-all]')!.click();
    });
    const dialogRows = document.querySelectorAll('[data-subagents-all-scroll] [data-agent-id]');
    expect(dialogRows.length).toBeGreaterThan(0);
    expect(dialogRows.length).toBeLessThan(35);
    const focused = await renderRail({
      agentForest: large,
      subagent: { agentId: 'main', block: undefined, pendingInteractionCount: 0, onJumpToSpawn: undefined },
    });
    const childRows = focused.querySelectorAll('[data-agent-children-nav] [data-agent-id]');
    expect(childRows.length).toBeGreaterThan(0);
    expect(childRows.length).toBeLessThan(25);
  });

  it('does not remeasure every task row when opening the tree dialog', async () => {
    const rail = await renderRail();
    const tasks = rail.querySelector('[data-tasks-scroll]')!;
    const measure = vi.spyOn(tasks, 'querySelectorAll');
    try {
      await act(async () => { rail.querySelector<HTMLButtonElement>('[data-subagents-view-all]')!.click(); });
      expect(measure).not.toHaveBeenCalled();
    } finally {
      measure.mockRestore();
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
