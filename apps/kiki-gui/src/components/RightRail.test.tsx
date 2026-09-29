// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import { buildAgentForest, createViewState, type ApprovalBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { RightRail, type SubagentRailContext } from './RightRail';
import { PreviewFocusBridge } from './SessionView';

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: ({ part = 'all', agentId }: { part?: string; agentId: string }) =>
    <div data-panel-props={part} data-panel-agent={agentId} />,
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

/** Data-driven chapters (the always-present setup / session chapters excluded). */
function sharedChapters(container: Element) {
  return [...container.querySelectorAll<HTMLElement>('[data-agent-panel-scroll] .rail-page > section:not([data-inspector-now])')]
    .map((section) => ({
      title: section.querySelector(':scope > div span.font-medium')?.textContent,
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
      // Todo / plan read live state only and mount at once; the overview
      // (which starts the capability read) waits for its slot to scroll in.
      expect(rail.querySelector('[data-panel-props="work"]')).not.toBeNull();
      expect(rail.querySelector('[data-panel-props="overview"]')).toBeNull();
      await act(async () => {
        notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(rail.querySelector('[data-panel-props="overview"]')).not.toBeNull();
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
    // The head leads the scroll content in both focus states.
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-agent-panel-scroll]')?.firstElementChild?.hasAttribute('data-rail-owner')).toBe(true);
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
    // Reading order: now, the resident overview, the agent's work slice,
    // tasks, then model and capabilities and the folded session row.
    const scroll = child.querySelector('[data-agent-panel-scroll]')!;
    const order = [
      now,
      scroll.querySelector('[data-rail-agent-panel-slot]'),
      scroll.querySelector('[data-panel-props="work"]'),
      scroll.querySelector('[data-tasks-scroll]'),
      scroll.querySelector('[data-inspector-setup]'),
      scroll.querySelector('[data-inspector-session]') ?? scroll.querySelector('[data-inspector-setup]'),
    ];
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

  it('opens model and capabilities by default and folds only the session row', async () => {
    const rail = await renderRail();
    const setup = rail.querySelector('[data-inspector-setup]');
    const toggle = setup?.querySelector<HTMLButtonElement>(':scope > div > button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(setup?.querySelector('[data-panel-props="setup"]')).not.toBeNull();
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

  it('windows a large roster, folds settled agents and filters by status', async () => {
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
    expect(rail.querySelector('[data-roster-done-group]')?.textContent).toContain('completed');
    expect(rail.querySelector('[data-roster-search]')).not.toBeNull();
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-roster-filter="failed"]')!.click(); });
    const failed = [...rail.querySelectorAll<HTMLElement>('[data-agent-tree] [data-agent-id]')];
    expect(failed.length).toBe(11);
    expect(failed.every((row) => row.dataset['rosterBucket'] === 'failed')).toBe(true);
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
    expect(block.textContent).toContain('From Lead › Worker');
    // It leads the page, above Now.
    expect(block.compareDocumentPosition(rail.querySelector('[data-inspector-now]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-needs-you-approve="a1"]')!.click(); });
    expect(decided).toEqual(['a1:approved']);
    // The lead's folded row says a descendant waits.
    expect(rail.querySelector('[data-agent-id="lead"]')?.textContent).toContain('1 needs you below');
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
