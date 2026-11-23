// @vitest-environment jsdom

import { act, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import { buildAgentForest, createViewState, SessionController, type ApprovalBlock, type SessionViewState } from '@kiki/session-core/session';
import type { SessionTransport } from '@kiki/session-core/transport';
import type { SessionViewFacade } from '@kiki/klient/session-view';
import { I18nProvider } from '../i18n';
import { RightRail, type SubagentRailContext } from './RightRail';
import { AgentBreadcrumb, AgentRelations } from './AgentBreadcrumb';
import { PreviewFocusBridge } from './SessionView';
import { useInspectorFocusTracking } from './inspectorFocus';
import { LiveControllerRegistry } from '../state/connection';

// The profile head and capability block read the agent panel over the
// connection; these fixtures have none, so they render as plain stand-ins.
vi.mock('./rail-variants/DefaultSections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rail-variants/DefaultSections')>()),
  ProfileHead: ({ label }: { label: string }) => <div data-rail-profile-head>{label}</div>,
  CapabilitiesBlock: () => null,
}));

// The session rail also mounts its cron section and the persona update, both of
// which read the connection and the settings stores these fixtures have no
// stand-in for; they render as the same kind of plain stand-in.
vi.mock('./rail-variants/SessionCronSection', () => ({
  SessionCronSection: () => <div data-rail-session-cron />,
}));

vi.mock('./persona/PersonaSettingsUpdate', () => ({
  PersonaSettingsUpdate: () => <div data-rail-persona-settings />,
}));

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: ({ part = 'all', agentId, scopeRootId, visible, renderOverview }: {
    part?: string; agentId: string; scopeRootId?: string; visible?: boolean;
    renderOverview?: (body: React.ReactNode, scopeSwitch: React.ReactNode) => React.ReactNode;
  }) => {
    const body = (
      <div
        data-panel-props={part}
        data-panel-agent={agentId}
        data-panel-scope-root={scopeRootId}
        data-panel-visible={visible === undefined ? undefined : String(visible)}
      />
    );
    return renderOverview === undefined ? body : renderOverview(body, <div data-usage-scope-switch />);
  },
}));

const pluginSlotsHolder: { current: readonly any[] } = { current: [] };
vi.mock('./plugins/PluginComposerSlots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plugins/PluginComposerSlots')>()),
  usePluginGuiSlots: () => ({ slots: pluginSlotsHolder.current }),
}));

const registryHolder: { current: any } = { current: null };
const connectionHolder: { current: any } = { current: null };
vi.mock('../state/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/connection')>();
  return {
    ...actual,
    useOptionalControllerRegistry: () => registryHolder.current,
    useOptionalConnection: () => connectionHolder.current,
  };
});

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
  registryHolder.current = null;
  connectionHolder.current = null;
  pluginSlotsHolder.current = [];
  localStorage.removeItem('kiki.railMode');
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
  stateOverrides,
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
  stateOverrides?: Partial<SessionViewState>;
} = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), tasks: (empty ? [] : stateTasks) ?? tasks, ...stateOverrides }}
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
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** The folded chapters after the pinned 现在 block, by their head text. */
function sharedChapters(container: Element) {
  const page = container.querySelector('[data-agent-panel-scroll] > .rail-page');
  if (page === null) return [];
  return [...page.querySelectorAll<HTMLElement>(':scope section, :scope div')]
    .flatMap((node) => {
      const head = node.querySelector(':scope > div > button, :scope > button, :scope h4');
      if (head === null || head.closest('[data-rail-pinned]') !== null) return [];
      const text = head.textContent ?? '';
      return text === '' ? [] : [text];
    });
}

it('shows runtime activity instead of an idle child transcript and returns to idle after settlement', async () => {
  const agentForest = (status: 'running' | 'idle') => buildAgentForest([], [
    { agentId: 'main', name: 'Main', status: 'idle', busy: false },
    { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'unknown', busy: false },
    { agentId: 'agent-1', parentAgentId: 'main', status, statusSource: 'runtime' },
  ]);
  const subagent: SubagentRailContext = {
    agentId: 'agent-1', pendingInteractionCount: 0, onJumpToSpawn: undefined,
    block: {
      id: 'child-card', kind: 'subagent', subagentId: 'agent-1', name: 'Researcher', status: 'idle',
      parentAgentId: 'main', parentToolCallId: undefined, description: undefined, model: undefined,
      thinkingEffort: undefined, summary: undefined, error: undefined, endedAt: undefined,
      toolCallCount: 0, transcript: [],
    },
  };
  const running = await renderRail({ subagent, empty: true, agentForest: agentForest('running') });
  expect(running.querySelector('[data-inspector-now]')?.getAttribute('data-inspector-now')).toBe('working');
  expect(running.querySelector('[data-inspector-now]')?.textContent).toContain('Working');
  const settled = await renderRail({ subagent, empty: true, agentForest: agentForest('idle') });
  expect(settled.querySelector('[data-inspector-now]')?.getAttribute('data-inspector-now')).toBe('idle');
  expect(settled.querySelector('[data-inspector-now]')?.textContent).toContain('Idle');
});

it('does not let stale parent activity resurrect a focused runtime-idle child', async () => {
  const agentForest = buildAgentForest([], [
    { agentId: 'main', name: 'Main', status: 'running' },
    { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'idle', statusSource: 'runtime' },
  ]);
  const subagent: SubagentRailContext = {
    agentId: 'agent-1', pendingInteractionCount: 0, onJumpToSpawn: undefined,
    block: {
      id: 'child-card', kind: 'subagent', subagentId: 'agent-1', name: 'Researcher', status: 'running',
      parentAgentId: 'main', parentToolCallId: undefined, description: undefined, model: undefined,
      thinkingEffort: undefined, summary: undefined, error: undefined, endedAt: undefined,
      toolCallCount: 0, transcript: [],
    },
  };
  const rail = await renderRail({
    subagent,
    empty: true,
    agentForest,
    stateOverrides: { busy: true },
  });
  expect(rail.querySelector('[data-inspector-now]')?.getAttribute('data-inspector-now')).toBe('idle');
  expect(rail.querySelector('[data-inspector-now]')?.textContent).not.toContain('Working');
  expect(rail.querySelector('[data-inspector-now]')?.textContent).not.toContain('Status unknown');
});

it('treats a historical running card as unknown when the session says nothing is executing', async () => {
  const agentForest = buildAgentForest([], [
    { agentId: 'main', name: 'Main', status: 'unknown' },
    { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'unknown', statusSource: 'metadata' },
  ]);
  const rail = await renderRail({
    subagent: {
      agentId: 'agent-1', pendingInteractionCount: 0, onJumpToSpawn: undefined,
      block: {
        id: 'child-card', kind: 'subagent', subagentId: 'agent-1', name: 'Researcher', status: 'running',
        parentAgentId: 'main', parentToolCallId: undefined, description: undefined, model: undefined,
        thinkingEffort: undefined, summary: undefined, error: undefined, endedAt: undefined,
        toolCallCount: 0, transcript: [],
      },
    },
    empty: true,
    agentForest,
    stateOverrides: {
      busy: true,
      session: { executing: false, metadata: { cwd: 'C:/tmp' } } as NonNullable<SessionViewState['session']>,
    },
  });
  expect(rail.querySelector('[data-inspector-now]')?.getAttribute('data-inspector-now')).toBe('idle');
  expect(rail.querySelector('[data-inspector-now]')?.textContent).not.toContain('Working');
  expect(rail.querySelector('[data-inspector-now]')?.textContent).not.toContain('Status unknown');
});

describe('RightRail Run | Config tabs and decluttered layout', () => {
  async function selectTab(rail: Element, tab: 'run' | 'config') {
    await act(async () => {
      rail.querySelector<HTMLButtonElement>(`[data-rail-tab="${tab}"]`)!.click();
    });
  }

  it('renders Run | Config hairline tabs in h-12 without cockpit switch and keeps Run reading order', async () => {
    const rail = await renderRail({ sessionPending: [pendingApproval] });
    // Cockpit mode switch is completely gone.
    expect(rail.querySelector('[data-rail-mode-switch]')).toBeNull();
    expect(rail.querySelector('[data-rail-mode]')).toBeNull();
    const runTab = rail.querySelector<HTMLButtonElement>('[data-rail-pinned] [data-rail-tab="run"]')!;
    const configTab = rail.querySelector<HTMLButtonElement>('[data-rail-pinned] [data-rail-tab="config"]')!;
    expect(runTab).not.toBeNull();
    expect(configTab).not.toBeNull();
    expect(runTab.getAttribute('aria-selected')).toBe('true');
    expect(configTab.getAttribute('aria-selected')).toBe('false');

    const runReadingOrder = [
      '[data-inspector-needs-you]',
      '[data-rail-now-block]',
      '[data-rail-agent-panel-slot]',
      '#rail-todos',
      '[data-tasks-scroll]',
      '[data-inspector-agents]',
      '[data-inspector-tail]',
    ].map((selector) => rail.querySelector(selector));
    expect(runReadingOrder.every((node) => node !== null)).toBe(true);
    expect(rail.querySelector('[data-rail-pinned] [data-rail-pending-jump]')?.textContent).toContain('1');
    expect(rail.querySelector('[data-rail-pinned] [data-inspector-needs-you]')).toBeNull();
    expect(rail.querySelector('.rail-page [data-inspector-needs-you]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-pinned] [data-rail-agent-panel-slot]')).toBeNull();
    expect(rail.querySelector('[data-inspector-agents] [data-agent-tree]')).not.toBeNull();
    // Todos section holds only RailTodos + plan (notes live in bottom history tail; hooks live in Config).
    expect(rail.querySelector('#rail-todos [data-panel-props="plan"]')).not.toBeNull();
    expect(rail.querySelector('#rail-todos [data-panel-props="notes"]')).toBeNull();
    expect(rail.querySelector('#rail-todos [data-panel-props="hooks"]')).toBeNull();
    expect(rail.querySelector('[data-inspector-tail] [data-panel-props="notes"]')).not.toBeNull();
    // Session config items (cron, persona, controls) stay out of Run tab.
    expect(rail.querySelector('[data-rail-session-cron]')).toBeNull();
    expect(rail.querySelector('[data-rail-persona-settings]')).toBeNull();

    for (const selector of ['[data-rail-agent-panel-slot]', '#rail-todos', '[data-inspector-tail]']) {
      expect(rail.querySelector(selector)?.classList.contains('border-t')).toBe(true);
    }
    for (let index = 1; index < runReadingOrder.length; index += 1) {
      const before = runReadingOrder[index - 1]!;
      const after = runReadingOrder[index]!;
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
  });

  it('demotes settled background tasks into the bottom history fold when no task is running', async () => {
    const settledOnly: Task[] = [
      {
        id: 'bg-done-1', session_id: 'sess-1', kind: 'bash', description: 'Finished build',
        status: 'completed', created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const rail = await renderRail({ stateTasks: settledOnly });
    const tasksSection = rail.querySelector('[data-rail-section="tasks"]')!;
    const tail = rail.querySelector('[data-inspector-tail]')!;
    expect(tasksSection).not.toBeNull();
    expect(tail.contains(tasksSection)).toBe(true);
    expect(tasksSection.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(tasksSection.textContent).toContain('1 settled');
  });

  it('switches to Config tab with live topology strip when active, 0px when idle, and switches back via pending jump', async () => {
    const onOpenSubagent = vi.fn();
    const activeForest = buildAgentForest([], [
      { agentId: 'main', name: 'Kiki', status: 'running', busy: true },
      { agentId: 'branch-a', parentAgentId: 'main', name: 'branch-a', label: 'Refactor rail', isBranch: true, status: 'running', busy: true },
      { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running', busy: true },
      { agentId: 'agent-2', parentAgentId: 'main', name: 'Reviewer', status: 'suspended', busy: false },
    ]);
    const rail = await renderRail({
      agentForest: activeForest,
      sessionPending: [pendingApproval],
      onOpenSubagent,
      stateOverrides: { busy: true },
    });

    await selectTab(rail, 'config');
    expect(rail.querySelector('[data-rail-panel="config"]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-config-topology]')).not.toBeNull();
    expect(rail.querySelector('[data-topology-connectors] svg, svg[data-topology-connectors]')).not.toBeNull();
    expect(rail.querySelector('[data-topology-node="branch-a"]')?.getAttribute('data-topology-kind')).toBe('branch');
    expect(rail.querySelector('[data-topology-node="agent-1"]')?.getAttribute('data-topology-kind')).toBe('subagent');
    expect(rail.querySelector('[data-rail-session-cron]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-persona-settings]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-config-foundation] [data-panel-props="hooks"]')).not.toBeNull();

    // Clicking a topology node opens that agent and switches back to Run.
    await act(async () => {
      rail.querySelector<HTMLButtonElement>('[data-topology-node="branch-a"]')!.click();
    });
    expect(onOpenSubagent).toHaveBeenCalledWith('branch-a');
    expect(rail.querySelector('[data-rail-panel="run"]')).not.toBeNull();

    // Pending jump button from Config switches back to Run.
    await selectTab(rail, 'config');
    expect(rail.querySelector('[data-rail-panel="config"]')).not.toBeNull();
    await act(async () => {
      rail.querySelector<HTMLButtonElement>('[data-rail-pending-jump]')!.click();
    });
    expect(rail.querySelector('[data-rail-panel="run"]')).not.toBeNull();

    // Idle session renders zero topology strip in Config.
    const idleRail = await renderRail({ empty: true, stateOverrides: { busy: false } });
    await selectTab(idleRail, 'config');
    expect(idleRail.querySelector('[data-rail-config-topology]')).toBeNull();
  });

  it('renders all live topology nodes directly without arbitrary truncation and returns to Run via summary', async () => {
    const onOpenSubagent = vi.fn();
    const manyForest = buildAgentForest([], [
      { agentId: 'main', name: 'Kiki', status: 'running', busy: true },
      ...Array.from({ length: 6 }, (_, i) => ({
        agentId: `worker-${i + 1}`,
        parentAgentId: 'main',
        name: `Worker ${i + 1}`,
        status: 'running' as const,
        busy: true,
      })),
    ]);
    const rail = await renderRail({ agentForest: manyForest, stateTasks: [], stateOverrides: { busy: true }, onOpenSubagent });
    await selectTab(rail, 'config');
    expect(rail.querySelectorAll('[data-topology-node]')).toHaveLength(6);
    expect(rail.querySelector('[data-topology-overflow]')).toBeNull();
    const sixth = rail.querySelector<HTMLButtonElement>('[data-topology-node="worker-6"]')!;
    expect(sixth).not.toBeNull();
    await act(async () => { sixth.click(); });
    expect(onOpenSubagent).toHaveBeenCalledWith('worker-6');
    await selectTab(rail, 'config');
    const summary = rail.querySelector<HTMLButtonElement>('[data-topology-summary]')!;
    await act(async () => { summary.click(); });
    expect(rail.querySelector('[data-rail-panel="run"]')).not.toBeNull();
  });

  it('isolates session-wide settings to main agent and renders compact sub-tabs when peeking a subagent', async () => {
    const peeked = await renderRail({ subagent: context, onInspectMain: vi.fn() });
    expect(peeked.querySelector('[data-rail-pinned] [data-rail-owner]')).not.toBeNull();
    expect(peeked.querySelector('[data-rail-sub-tabs] [data-rail-tab="run"]')).not.toBeNull();
    expect(peeked.querySelector('[data-rail-sub-tabs] [data-rail-tab="config"]')).not.toBeNull();

    await selectTab(peeked, 'config');
    expect(peeked.querySelector('[data-rail-section="environment"]')).toBeNull();
    expect(peeked.querySelector('[data-rail-session-cron]')).toBeNull();
    expect(peeked.querySelector('[data-rail-persona-settings]')).toBeNull();
    expect(peeked.querySelector('[data-inspector-session]')).toBeNull();
    expect(peeked.querySelector('[data-rail-config-foundation] [data-panel-props="hooks"]')).not.toBeNull();
  });

  it('re-attaches IntersectionObserver across Run -> Config -> Run so panelSlot.visible recovers', async () => {
    const originalIO = globalThis.IntersectionObserver;
    const instances: Array<{
      cb: IntersectionObserverCallback;
      observed: Element[];
      disconnected: boolean;
    }> = [];
    class FakeIntersectionObserver {
      readonly cb: IntersectionObserverCallback;
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        instances.push(this);
      }
      observe(el: Element) { this.observed.push(el); }
      unobserve() {}
      disconnect() { this.disconnected = true; }
      takeRecords() { return []; }
    }
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    try {
      const rail = await renderRail();
      expect(instances).toHaveLength(1);
      const firstObserver = instances[0]!;
      await act(async () => {
        firstObserver.cb([{ isIntersecting: true } as IntersectionObserverEntry], firstObserver as unknown as IntersectionObserver);
      });
      expect(rail.querySelector('[data-panel-props="overview"]')?.getAttribute('data-panel-visible')).toBe('true');

      await selectTab(rail, 'config');
      expect(firstObserver.disconnected).toBe(true);

      await selectTab(rail, 'run');
      expect(instances).toHaveLength(2);
      const secondObserver = instances[1]!;
      expect(secondObserver.observed).toHaveLength(1);
      await act(async () => {
        secondObserver.cb([{ isIntersecting: true } as IntersectionObserverEntry], secondObserver as unknown as IntersectionObserver);
      });
      expect(rail.querySelector('[data-panel-props="overview"]')?.getAttribute('data-panel-visible')).toBe('true');
      expect(rail.querySelector('[data-panel-props="notes"]')?.getAttribute('data-panel-visible')).toBe('true');
    } finally {
      globalThis.IntersectionObserver = originalIO;
    }
  });

  it('counts only actively running subagents in topology summary without double-counting waiting ones', async () => {
    const mixedForest = buildAgentForest([], [
      { agentId: 'main', name: 'Kiki', status: 'running', busy: true },
      { agentId: 'w1', parentAgentId: 'main', name: 'Waiter 1', status: 'suspended', busy: false },
      { agentId: 'w2', parentAgentId: 'main', name: 'Waiter 2', status: 'suspended', busy: false },
      { agentId: 'r1', parentAgentId: 'main', name: 'Runner 1', status: 'running', busy: true },
    ]);
    const approvals: ApprovalBlock[] = [
      { ...pendingApproval, id: 'a1', originAgentId: 'w1' },
      { ...pendingApproval, id: 'a2', originAgentId: 'w2' },
    ];
    const rail = await renderRail({
      agentForest: mixedForest,
      stateTasks: [],
      stateOverrides: { busy: true },
      sessionPending: approvals,
    });
    await selectTab(rail, 'config');
    const summary = rail.querySelector('[data-topology-summary]')?.textContent ?? '';
    expect(summary).toContain('2');
    expect(summary).toContain('1 Running');
    expect(summary).not.toContain('3 Running');
  });

  it('scopes topology pendingCount to the peeked subagent so idle children collapse to 0px', async () => {
    const idleChildForest = buildAgentForest([], [
      { agentId: 'main', name: 'Kiki', status: 'running', busy: true },
      { agentId: 'agent-1', parentAgentId: 'main', name: 'Done Worker', status: 'completed', busy: false },
      { agentId: 'other-agent', parentAgentId: 'main', name: 'Other Waiter', status: 'suspended', busy: false },
    ]);
    const otherApproval: ApprovalBlock[] = [
      { ...pendingApproval, id: 'a-other', originAgentId: 'other-agent' },
    ];
    const idleSubagent: SubagentRailContext = {
      ...context,
      pendingInteractionCount: 0,
      block: { ...context.block!, status: 'completed' },
    };
    const rail = await renderRail({
      agentForest: idleChildForest,
      subagent: idleSubagent,
      stateTasks: [],
      sessionPending: otherApproval,
      onInspectMain: vi.fn(),
    });
    await selectTab(rail, 'config');
    expect(rail.querySelector('[data-rail-config-topology]')).toBeNull();
  });

  it('keeps the overview flat and places the scope switch beside its title and usage link', async () => {
    const rail = await renderRail();
    const well = rail.querySelector('[data-rail-overview-well]')!;
    expect(well.className).not.toMatch(/(?:^|\s)(?:rounded|bg|border|ring|shadow)(?:-|\s|$)/);
    expect(well.querySelector('#rail-overview-title')).not.toBeNull();
    expect(well.closest('[data-rail-agent-panel-slot]')?.classList.contains('border-t')).toBe(true);

    const head = rail.querySelector('[data-rail-switchable-head]')!;
    expect(head.querySelector('#rail-overview-title')).not.toBeNull();
    expect(head.querySelector('[data-rail-open-usage]')).not.toBeNull();
    expect(head.querySelector('[data-usage-scope-switch]')).not.toBeNull();
    expect(head.classList.contains('items-baseline')).toBe(true);
    expect(head.classList.contains('flex-nowrap')).toBe(true);
    expect(head.querySelector('#rail-overview-title')?.classList.contains('whitespace-nowrap')).toBe(true);
    expect(rail.querySelector('#rail-overview-body [data-usage-scope-switch]')).toBeNull();
  });

  it('renders the main agent and a subagent with the same rail, each from its own agent', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });
    const shape = (rail: Element) => ['[data-rail-owner]', '[data-rail-now-block]', '#rail-todos', '[data-rail-agent-panel-slot]']
      .map((selector) => rail.querySelectorAll(selector).length);
    expect(shape(child)).toEqual([1, 1, 1, 1]);
    expect(shape(main)).toEqual(shape(child));
    expect(main.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent')).toBe('main');
    expect(child.querySelector('[data-session-rail]')?.getAttribute('data-inspector-agent')).toBe('agent-1');
    for (const part of ['plan', 'notes', 'overview']) {
      expect(main.querySelector(`[data-panel-props="${part}"]`)?.getAttribute('data-panel-agent')).toBe('main');
      expect(child.querySelector(`[data-panel-props="${part}"]`)?.getAttribute('data-panel-agent')).toBe('agent-1');
    }
    expect(main.querySelector('[data-rail-profile-head]')?.textContent).toBe('Main');
    expect(child.querySelector('[data-rail-profile-head]')?.textContent).toBe('Researcher');
    expect(main.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
    expect(child.querySelector('[data-terminate-all-subagents]')).toBeNull();
    expect(main.querySelector('[data-rail-locate]')).toBeNull();
    expect(child.querySelector('[data-rail-locate]')).not.toBeNull();
  });

  it('offers promotion only for a subagent and calls the real session action boundary', async () => {
    const promoteAgent = vi.fn(async () => ({ id: 'promoted-thread' }));
    connectionHolder.current = { client: { promoteAgent, sessions: { promoteAgent } } };
    const main = await renderRail();
    const child = await renderRail({ subagent: context });
    expect(main.querySelector('[data-rail-promote]')).toBeNull();
    const action = child.querySelector<HTMLButtonElement>('[data-rail-promote]');
    expect(action?.textContent).toBe('Open as thread');
    await act(async () => { action?.click(); });
    expect(promoteAgent).toHaveBeenCalledExactlyOnceWith('sess-1', 'agent-1');
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
      expect(rail.querySelector('[data-panel-props="plan"]')).not.toBeNull();
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

  it('uses an overview heading when matching center and breadcrumb when peeking another agent', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context, onInspectMain: vi.fn() });

    const mainOwner = main.querySelector('[data-rail-owner]');
    expect(mainOwner?.querySelector('[data-rail-owner-heading]')?.textContent).toBe('Overview');
    expect(main.querySelector('#rail-overview-title')?.textContent).toBe('Usage');
    expect(mainOwner?.querySelector('[data-inspect-main]')).toBeNull();
    expect(mainOwner?.getAttribute('data-rail-owner-name')).toBeNull();
    // Peeking a subagent from main: "Main agent / Researcher", main a step back up.
    const childOwner = child.querySelector('[data-rail-owner]');
    expect(childOwner?.getAttribute('data-rail-owner-name')).toBe('Researcher');
    expect(childOwner?.querySelector('[aria-current="page"]')?.textContent).toContain('Researcher');
    expect(childOwner?.querySelector('[data-inspect-main]')?.textContent).toBe('Main agent');
    // The pinned h-12 bar leads the scroll content in both focus states.
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

    // Main's team is open from the start: its rows read without a click.
    expect(main.querySelector('[data-inspector-agents] [aria-expanded]')).toBeNull();
    expect(main.querySelector('[data-agent-tree] [data-agent-id="agent-1"]')).not.toBeNull();
    expect(main.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
    // Background tasks are their own open section on both pages, each row
    // with its stop; nothing repeats them in the pinned block.
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-rail-section="tasks"] [data-tasks-scroll] [data-task-open="background-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-task-open="subagent-1"]')).toBeNull();
      expect(rail.querySelector('[data-panel-props]')).not.toBeNull();
      expect(rail.querySelector('[data-rail-pinned] [data-tasks-scroll]')).toBeNull();
    }
    expect(child.querySelector('[data-inspector-agents]')).toBeNull();
    expect(main.querySelector('[data-subagent-context]')).toBeNull();
    // The focused subagent: Now says its state (waiting on the user here) and
    // offers its own controls; the team roster stays on main's page.
    const now = child.querySelector('[data-inspector-now]');
    expect(now?.querySelector('[data-needs-input]')).not.toBeNull();
    expect(now?.textContent).toContain('Needs you');
    expect(child.querySelector('[data-subagent-context] [data-rail-locate]')).not.toBeNull();
    // Reading order: the pinned profile head and Now, context and cost
    // (overview), then the record chapter with the agent's work and its tasks.
    const scroll = child.querySelector('[data-agent-panel-scroll]')!;
    expect(scroll.querySelector('[data-inspector-setup]')).toBeNull();
    // Session-level cron lives in main's Config tab and never leaks to a subagent rail.
    expect(main.querySelector('[data-rail-session-cron]')).toBeNull();
    await act(async () => { main.querySelector<HTMLButtonElement>('[data-rail-tab="config"]')!.click(); });
    expect(main.querySelector('[data-rail-session-cron]')).not.toBeNull();
    expect(scroll.querySelector('[data-rail-session-cron]')).toBeNull();
    const order = [
      scroll.querySelector('[data-rail-profile-head]'),
      now,
      scroll.querySelector('[data-rail-agent-panel-slot]'),
      scroll.querySelector('[data-panel-props="plan"]'),
      scroll.querySelector('[data-tasks-scroll]'),
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
    // Peeking a nested agent shows the full breadcrumb chain back to main.
    const nested = await renderRail({
      agentForest: deep,
      onInspectMain: () => {},
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

  it('leads with the profile head and folds the session row without a fold inside it', async () => {
    const sessionFixture = {
      id: 'sess-1',
      workspace_id: 'ws-1',
      metadata: { cwd: 'C:/work/workshop' },
      agent_config: {},
      message_count: 3,
      updated_at: '2026-01-01T00:00:00.000Z',
    } as NonNullable<SessionViewState['session']>;
    const mainRail = await renderRail({ stateOverrides: { session: sessionFixture } });
    const nowBlock = mainRail.querySelector('[data-rail-now-block]')!;
    expect(nowBlock.firstElementChild?.hasAttribute('data-rail-profile-head')).toBe(true);
    expect(mainRail.querySelector('[data-inspector-setup]')).toBeNull();
    expect(mainRail.querySelector('[data-inspector-session]')).toBeNull();
    await act(async () => { mainRail.querySelector<HTMLButtonElement>('[data-rail-tab="config"]')!.click(); });
    const session = mainRail.querySelector('[data-inspector-session]')!;
    expect(session).not.toBeNull();
    const button = session.querySelector<HTMLButtonElement>(':scope > div > button[aria-expanded="false"]')!;
    expect(button.textContent).toContain('Session');
    expect(button.textContent).toContain('workshop');
    await act(async () => { button.click(); });
    expect(session.querySelectorAll('[aria-expanded]')).toHaveLength(1);
    expect(session.querySelector('dl')?.textContent).toContain('C:/work/workshop');

    // Session-scoped directory row must not leak onto a subagent rail.
    const childRail = await renderRail({ subagent: context, stateOverrides: { session: sessionFixture } });
    await act(async () => { childRail.querySelector<HTMLButtonElement>('[data-rail-tab="config"]')!.click(); });
    expect(childRail.querySelector('[data-inspector-session]')).toBeNull();
  });

  it('keeps the resident overview in every state, idle and empty included', async () => {
    for (const subagent of [undefined, context]) {
      const empty = await renderRail({ subagent, empty: true });
      expect(empty.querySelector('[data-inspector-agents]')).toBeNull();
      expect(empty.querySelector('[data-tasks-scroll]')).toBeNull();
      expect(empty.querySelector('[data-rail-agent-panel-slot]')).not.toBeNull();
      expect(empty.querySelector('[data-subagent-context]') !== null).toBe(subagent !== undefined);
    }
    // A populated team is open: its status chips and rows are on the page.
    const populated = await renderRail();
    expect(populated.querySelector('[data-inspector-agents] [data-roster-summary]')).not.toBeNull();
    expect(populated.querySelector('[data-inspector-agents] [data-agent-tree]')).not.toBeNull();
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

  it('folds historical unknown agents without hiding an unknown parent that still has a running child', async () => {
    const historical = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      { agentId: 'parent', parentAgentId: 'main', name: 'Parent', status: 'unknown' },
      { agentId: 'child', parentAgentId: 'parent', name: 'Child', status: 'running' },
      ...Array.from({ length: 4 }, (_, index) => ({
        agentId: `old-${index}`, parentAgentId: 'main', name: `Old ${index}`, status: 'unknown' as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        agentId: `done-${index}`, parentAgentId: 'main', name: `Done ${index}`, status: 'completed' as const,
      })),
    ]);
    const rail = await renderRail({ agentForest: historical });
    expect(rail.querySelector('[data-agent-id="parent"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
    expect(rail.querySelector('[data-agent-id="old-0"]')).toBeNull();
    const unknown = rail.querySelector<HTMLButtonElement>('[data-roster-unknown-group]');
    expect(unknown?.textContent).toContain('4 status unknown');
    expect(unknown?.textContent).not.toContain('Idle');
    expect(unknown?.textContent).not.toContain('finished');
    expect(unknown?.getAttribute('aria-expanded')).toBe('false');
    expect(rail.querySelector('[data-roster-done-group]')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { unknown?.click(); });
    expect(rail.querySelector('[data-agent-id="old-0"]')?.querySelector('[data-agent-status]')?.textContent).toBe('Status unknown');
    expect(rail.querySelector('[data-roster-done-group]')?.getAttribute('aria-expanded')).toBe('false');
    expect(rail.querySelector('[data-agent-id="done-0"]')).toBeNull();
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-roster-toggle="parent"]')?.click(); });
    expect(rail.querySelector('[data-agent-id="child"]')?.getAttribute('data-roster-bucket')).toBe('running');
    await act(async () => { rail.querySelector<HTMLButtonElement>('[data-roster-filter="unknown"]')?.click(); });
    expect(rail.querySelector('[data-roster-unknown-group]')).toBeNull();
    expect(rail.querySelector('[data-agent-id="old-0"]')).not.toBeNull();
    expect(rail.querySelector('[data-agent-id="parent"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
    expect(rail.querySelector('[data-agent-id="child"]')).toBeNull();
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
    // NeedsYou sits first in the scrolling rail page, above InspectorNow and the team.
    expect(block.compareDocumentPosition(rail.querySelector('[data-inspector-now]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    if (entry === 'roster') {
    }
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

function createMockController(sessionId: string, initialMainState: SessionViewState) {
  let mainState = initialMainState;
  const agentStates = new Map<string, SessionViewState>();
  const listeners = new Set<() => void>();
  const agentListeners = new Map<string, Set<() => void>>();
  const refreshSession = vi.fn();

  // Like the real controller, main is served through the per-agent reads too:
  // `getAgentState('main')` is the session view and `subscribeAgent('main')`
  // hears its publications.
  return {
    sessionId,
    getState: () => mainState,
    getAgentState: (id: string) => id === 'main' ? mainState : agentStates.get(id),
    setMainState: (next: SessionViewState) => {
      mainState = next;
      for (const l of listeners) l();
    },
    setAgentState: (id: string, next: SessionViewState) => {
      agentStates.set(id, next);
      agentListeners.get(id)?.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    subscribeAgent: (id: string, l: () => void) => {
      if (id === 'main') {
        listeners.add(l);
        return () => { listeners.delete(l); };
      }
      let set = agentListeners.get(id);
      if (!set) {
        set = new Set();
        agentListeners.set(id, set);
      }
      set.add(l);
      return () => { set?.delete(l); };
    },
    refreshSession,
  };
}

function createMockRegistry(controller: any) {
  let ver = 1;
  const listeners = new Set<() => void>();
  return {
    add: () => {},
    delete: () => {},
    acquire: () => ({ controller, release: () => {} }),
    [Symbol.iterator]: () => [controller][Symbol.iterator]() as Iterator<SessionController>,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    snapshot: () => ver,
    bump: () => { ver++; for (const l of listeners) l(); },
  };
}

describe('RightRail Todos resilient baseline and fallback', () => {
  it('displays current main todos when registry is missing controller (fallback to routed state)', async () => {
    const rail = await renderRail({
      stateOverrides: {
        loaded: true,
        transcriptReady: true,
        todos: [
          { title: 'Main task via routed state', status: 'pending' },
          { title: 'Completed milestone', status: 'done' },
        ],
      },
    });
    expect(rail.querySelector('[data-rail-todos]')).not.toBeNull();
    expect(rail.textContent).toContain('Main task via routed state');
    expect(rail.textContent).toContain('Completed milestone');
  });

  it('strictly isolates main and subagent so sub does not borrow main todos', async () => {
    const rail = await renderRail({
      subagent: context,
      stateOverrides: {
        loaded: true,
        transcriptReady: true,
        todos: [
          { title: 'Main secret task', status: 'pending' },
        ],
      },
    });
    expect(rail.textContent).not.toContain('Main secret task');
    expect(rail.querySelector('[data-rail-todos]')).toBeNull();
  });

  it('renders lightweight loading state when shell is loaded but Todo baseline is unconfirmed', async () => {
    const rail = await renderRail({
      stateOverrides: {
        loaded: true,
        transcriptReady: false,
        todos: [],
      },
    });
    expect(rail.querySelector('[data-rail-todos-loading]')).not.toBeNull();
    expect(rail.querySelector('[role="status"]')?.textContent).toContain('Reading todos…');
  });

  it('does not resurrect old stale todos once empty baseline is confirmed', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    mounts.push({ container: mount, root });

    // Step 1: initial render with an active task
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), loaded: true, transcriptReady: true, todos: [{ title: 'Stale todo item', status: 'pending' }], tasks: [] }}
              forest={forest}
              onCancelTask={() => {}}
              onStopAgentTask={async () => {}}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    expect(mount.textContent).toContain('Stale todo item');

    // Step 2: confirmed empty reset
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), loaded: true, transcriptReady: true, todos: [], tasks: [] }}
              forest={forest}
              onCancelTask={() => {}}
              onStopAgentTask={async () => {}}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    expect(mount.textContent).not.toContain('Stale todo item');
    expect(mount.querySelector('[data-rail-todos]')).toBeNull();
  });

  it('renders lightweight loading state when controller exists with shell loaded but transcript unconfirmed (Astra counterexample)', async () => {
    const ctrl = createMockController('sess-1', {
      ...createViewState('sess-1'),
      loaded: true,
      transcriptReady: false,
      todos: [],
    });
    registryHolder.current = createMockRegistry(ctrl);

    const rail = await renderRail();
    expect(rail.querySelector('[data-rail-todos-loading]')).not.toBeNull();
    expect(rail.querySelector('[role="status"]')?.textContent).toContain('Reading todos…');
  });

  it('clears retained todos and does not resurrect them when real controller confirms empty baseline', async () => {
    const view = {
      snapshot: async () => ({
        as_of_seq: 1,
        epoch: 'e',
        session: {
          id: 'sess-1',
          workspace_id: 'workspace_example',
          metadata: { cwd: 'C:/example' },
          agent_config: {},
          usage: { turn_count: 0 },
        },
        in_flight_turn: null,
      }),
      transcript: { page: vi.fn(), content: vi.fn() },
      subscribe: () => ({
        close() {},
        updateTranscriptCursor() {},
        updateSessionCursor() {},
        setTranscriptGrades() {},
      }),
    } as unknown as SessionViewFacade;

    const controller = new SessionController({} as SessionTransport, view, 'sess-1', {
      scheduler: { schedule: (fn) => { fn(); return 0; }, cancel() {} },
    });
    const registry = new LiveControllerRegistry();
    registry.add(controller);
    registryHolder.current = registry;

    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    mounts.push({ container: mount, root });

    // Step 1: Initial mount before open or transcript - shell loading / unconfirmed
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), loaded: false, transcriptReady: false, tasks: [] }}
              forest={forest}
              onCancelTask={() => {}}
              onStopAgentTask={async () => {}}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    // Step 2: Controller open - shell loaded, but transcript not yet ready (todo baseline unconfirmed)
    await act(async () => {
      await controller.open();
    });
    expect(mount.querySelector('[data-rail-todos-loading]')).not.toBeNull();

    // Step 3: Todo baseline arrives with active todos
    await act(async () => {
      controller.handleTranscript({
        type: 'transcript.reset',
        session_id: 'sess-1',
        agent_id: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          prompts: [],
          meta: {},
          todos: [{ todoId: 'todo', items: [{ title: 'Active real task', status: 'pending' }] }],
        },
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        cursor: { seq: 1, epoch: 'e' },
      });
    });

    expect(mount.textContent).toContain('Active real task');
    expect(mount.querySelector('[data-rail-todos]')).not.toBeNull();

    // Step 4: Real controller receives transcript update confirming empty todos
    await act(async () => {
      controller.handleTranscript({
        type: 'transcript.reset',
        session_id: 'sess-1',
        agent_id: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          prompts: [],
          meta: {},
          todos: [{ todoId: 'todo', items: [] }],
        },
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        cursor: { seq: 2, epoch: 'e' },
      });
    });

    // Step 5: Confirmed empty! Retained cache is cleared, and does not resurrect
    expect(mount.textContent).not.toContain('Active real task');
    expect(mount.querySelector('[data-rail-todos]')).toBeNull();

    controller.close();
  });

  it('strictly isolates scope on agent and session switch so subagent does not borrow main todos', async () => {
    const ctrl = createMockController('sess-1', {
      ...createViewState('sess-1'),
      loaded: true,
      transcriptReady: true,
      todos: [{ title: 'Main secret task', status: 'pending' }],
    });
    registryHolder.current = createMockRegistry(ctrl);

    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    mounts.push({ container: mount, root });

    // Render with main focused
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), loaded: true, transcriptReady: true, tasks: [] }}
              forest={forest}
              onCancelTask={() => {}}
              onStopAgentTask={async () => {}}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    expect(mount.textContent).toContain('Main secret task');

    // Switch focus to subagent (which has no todos)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{ ...createViewState('sess-1'), loaded: true, transcriptReady: true, tasks: [] }}
              forest={forest}
              subagent={context}
              selectedAgentId={context.agentId}
              onCancelTask={() => {}}
              onStopAgentTask={async () => {}}
              onOpenSubagent={() => {}}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });
    expect(mount.textContent).not.toContain('Main secret task');
    expect(mount.querySelector('[data-rail-todos]')).toBeNull();
  });

  it('renders lightweight error recovery state with actionable retry when todo read fails', async () => {
    const ctrl = createMockController('sess-1', {
      ...createViewState('sess-1'),
      loaded: false,
      transcriptReady: false,
      loadError: 'Failed to load session transcript',
      todos: [],
    });
    registryHolder.current = createMockRegistry(ctrl);

    const rail = await renderRail();
    expect(rail.querySelector('[data-rail-todos-error]')).not.toBeNull();
    expect(rail.textContent).toContain('Could not read todos');
    const retryBtn = rail.querySelector<HTMLButtonElement>('[data-rail-todos-retry]');
    expect(retryBtn).not.toBeNull();
    await act(async () => {
      retryBtn?.click();
    });
    expect(ctrl.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('places Branches right below overview, separates branches from Agents and Terminate all, and renders distinct branch chips in AgentRelations', async () => {
    const onOpenSubagent = vi.fn();
    const onInspectMain = vi.fn();
    const branchForest = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      {
        agentId: 'branch-live',
        parentAgentId: 'main',
        name: 'Verify auth token refresh',
        description: 'Trace OAuth refresh race in background tabs',
        isBranch: true,
        branchSeed: 'fresh',
        status: 'running',
        busy: true,
        startedAt: '2026-01-01T00:10:00.000Z',
      },
      {
        agentId: 'branch-open',
        parentAgentId: 'main',
        name: 'Compare SQLite WAL tuning',
        description: 'Check synchronous=NORMAL vs FULL latency',
        isBranch: true,
        branchSeed: 'compact',
        toolsLocked: true,
        status: 'idle',
        startedAt: '2026-01-01T00:08:00.000Z',
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        agentId: `branch-merged-${index + 1}`,
        parentAgentId: 'main',
        name: `Merged check ${index + 1}`,
        isBranch: true,
        branchSeed: 'verbatim' as const,
        branchSealed: true,
        status: 'completed' as const,
        startedAt: `2026-01-01T00:0${index + 1}:00.000Z`,
        endedAt: `2026-01-01T00:0${index + 1}:30.000Z`,
      })),
      {
        agentId: 'worker-1',
        parentAgentId: 'main',
        name: 'Explore codebase',
        status: 'completed',
      },
    ]);
    const branchTasks: Task[] = [
      {
        id: 'task-branch-live',
        session_id: 'sess-1',
        kind: 'subagent',
        agent_id: 'branch-live',
        description: 'Verify auth token refresh',
        status: 'running',
        created_at: '2026-01-01T00:10:00.000Z',
      },
    ];
    const foldBlock = {
      kind: 'user' as const,
      id: 'user-fold-1',
      text: 'Merged branch branch-merged-6 (Merged check 6):\n\nConfirmed schema v3 migration cleans up stale indexes.\n\nBranch history: HistoryList({ agent_id: "branch-merged-6" })',
      createdAt: '2026-01-01T00:06:35.000Z',
      branchFold: {
        branchId: 'branch-merged-6',
        branchTitle: 'Merged check 6',
        done: true,
      },
    };

    const rail = await renderRail({
      agentForest: branchForest,
      stateTasks: branchTasks,
      onOpenSubagent,
      onInspectMain,
      stateOverrides: { blocks: [foldBlock] },
    });

    const sectionOrder = [...rail.querySelectorAll<HTMLElement>('[data-rail-section], [data-rail-agent-panel-slot]')]
      .map((el) => el.dataset['railSection'] ?? 'overview');
    expect(sectionOrder.indexOf('branches')).toBe(1);
    expect(sectionOrder.indexOf('branches')).toBeLessThan(sectionOrder.indexOf('agents'));

    // Running branch tasks must never trigger "Terminate all" in the subagent worker header:
    expect(rail.querySelector('[data-terminate-all-subagents]')).toBeNull();

    // Agents section counts only the 1 non-branch worker, not the 8 branches:
    const agentsSection = rail.querySelector('[data-rail-section="agents"]')!;
    expect(agentsSection.textContent).not.toContain('Verify auth token refresh');
    expect(agentsSection.textContent).not.toContain('Merged check');

    // Branches section renders compact single-line open rows and keeps merged history folded until opened:
    const branchesSection = rail.querySelector('[data-rail-section="branches"]')!;
    expect(branchesSection.querySelector('[data-branch-row="branch-live"]')?.getAttribute('data-branch-state')).toBe('running');
    expect(branchesSection.querySelector('[data-branch-row="branch-open"]')?.getAttribute('data-branch-state')).toBe('open');
    expect(branchesSection.querySelectorAll('[data-branch-state="merged"]')).toHaveLength(0);

    const mergedToggle = branchesSection.querySelector<HTMLButtonElement>('[data-branches-more]')!;
    await act(async () => { mergedToggle.click(); });
    expect(branchesSection.querySelector('[data-branch-row="branch-merged-6"]')?.getAttribute('title')).toContain('Confirmed schema v3 migration cleans up stale indexes.');
    expect(branchesSection.querySelectorAll('[data-branch-state="merged"]')).toHaveLength(5);

    const moreMergedBtn = branchesSection.querySelector<HTMLButtonElement>('[data-branches-more-merged]')!;
    expect(moreMergedBtn.textContent).toContain('Merged (1)');
    await act(async () => { moreMergedBtn.click(); });
    expect(branchesSection.querySelectorAll('[data-branch-state="merged"]')).toHaveLength(6);

    await act(async () => {
      branchesSection.querySelector<HTMLButtonElement>('[data-branch-row="branch-merged-6"]')?.click();
    });
    expect(onOpenSubagent).toHaveBeenCalledWith('branch-merged-6');

    // When only merged branches exist (no open branches), the Branches chapter starts collapsed to one quiet line:
    const mergedOnlyForest = buildAgentForest([], [
      {
        agentId: 'branch-merged-only-1',
        parentAgentId: 'main',
        label: 'Old exploration',
        status: 'completed',
        isBranch: true,
        branchSealed: true,
        startedAt: '2026-04-01T00:00:00.000Z',
        endedAt: '2026-04-01T00:01:00.000Z',
      },
    ]);
    const mergedOnlyRail = await renderRail({
      agentForest: mergedOnlyForest,
      stateTasks: [],
      onOpenSubagent,
      onInspectMain,
    });
    const mergedOnlySection = mergedOnlyRail.querySelector('[data-rail-section="branches"]')!;
    const mergedOnlyHeader = mergedOnlySection.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(mergedOnlyHeader.getAttribute('aria-expanded')).toBe('false');
    expect(mergedOnlySection.querySelector('[data-branch-row="branch-merged-only-1"]')).toBeNull();
    await act(async () => { mergedOnlyHeader.click(); });
    expect(mergedOnlyHeader.getAttribute('aria-expanded')).toBe('true');
    expect(mergedOnlySection.querySelector('[data-branch-row="branch-merged-only-1"]')).not.toBeNull();

    // When viewing a branch, the Branches header exposes a quick "Main" return action:
    const focusedRail = await renderRail({
      agentForest: branchForest,
      stateTasks: [],
      subagent: {
        agentId: 'branch-merged-6',
        block: undefined,
        pendingInteractionCount: 0,
        onJumpToSpawn: () => {},
      },
      onOpenSubagent,
      onInspectMain,
    });
    expect(focusedRail.querySelector('[data-branch-row="branch-merged-6"]')?.hasAttribute('data-branch-focused')).toBe(true);
    await act(async () => {
      focusedRail.querySelector<HTMLButtonElement>('[data-branches-back-to-main]')?.click();
    });
    expect(onInspectMain).toHaveBeenCalledTimes(1);

    // Empty session with 0 branches renders no branches section at all:
    const emptyRail = await renderRail({ empty: true });
    expect(emptyRail.querySelector('[data-rail-section="branches"]')).toBeNull();

    // Top relations strip & breadcrumb mark branches with [data-branch-chip] / [data-branch-crumb]:
    const stripMount = document.createElement('div');
    document.body.append(stripMount);
    const stripRoot = createRoot(stripMount);
    mounts.push({ container: stripMount, root: stripRoot });
    await act(async () => {
      stripRoot.render(
        <I18nProvider>
          <AgentBreadcrumb
            crumbs={[branchForest.byId['main']!, branchForest.byId['branch-open']!]}
            onOpenSession={() => {}}
            onOpenAgent={() => {}}
          />
          <AgentRelations forest={branchForest} currentAgentId="main" onOpen={onOpenSubagent} />
        </I18nProvider>,
      );
    });
    expect(stripMount.querySelector('[data-branch-crumb="open"]')?.textContent).toContain('Compare SQLite WAL tuning');
    expect(stripMount.querySelector('[data-branch-chip="open"][data-agent-id="branch-live"]')).not.toBeNull();
    expect(stripMount.querySelector('[data-branch-chip="merged"][data-agent-id="branch-merged-1"]')).not.toBeNull();
    expect(stripMount.querySelector('[data-agent-id="worker-1"]')?.hasAttribute('data-branch-chip')).toBe(false);
  });
});

describe('RightRail sibling-aware resize clamp', () => {
  it('caps docked rail drag width so conversation-center keeps its reading floor alongside preview', async () => {
    if (typeof globalThis.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', MouseEvent);
    }
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    const innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    try {
      const row = document.createElement('div');
      row.className = 'conversation-row';
      row.style.columnGap = '8px';
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        left: 264, right: 1592, top: 0, bottom: 900, width: 1328, height: 900, x: 264, y: 0, toJSON: () => ({}),
      });
      const previewStub = document.createElement('aside');
      previewStub.setAttribute('data-preview-workspace', '');
      vi.spyOn(previewStub, 'getBoundingClientRect').mockReturnValue({
        left: 864, right: 1284, top: 0, bottom: 900, width: 420, height: 900, x: 864, y: 0, toJSON: () => ({}),
      });
      const railSlot = document.createElement('div');
      railSlot.className = 'conversation-rail-slot';
      row.append(previewStub, railSlot);
      document.body.append(row);
      const root = createRoot(railSlot);
      mounts.push({ container: row, root });
      await act(async () => {
        root.render(
          <MemoryRouter>
            <I18nProvider>
              <RightRail
                state={{ ...createViewState('sess-1'), tasks: [] }}
                forest={forest}
                onCancelTask={() => {}}
                onStopAgentTask={async () => {}}
                onOpenSubagent={() => {}}
              />
            </I18nProvider>
          </MemoryRouter>,
        );
      });
      const railAside = railSlot.querySelector<HTMLElement>('[data-session-rail]')!;
      vi.spyOn(railAside, 'getBoundingClientRect').mockReturnValue({
        left: 1292, right: 1592, top: 0, bottom: 900, width: 300, height: 900, x: 1292, y: 0, toJSON: () => ({}),
      });
      const handle = railSlot.querySelector<HTMLElement>('[data-rail-resizer]')!;
      await act(async () => {
        handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 1292, bubbles: true }));
        handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, bubbles: true }));
        handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 900, bubbles: true }));
      });
      // Available width: 1328 (row) - 480 (center floor at >=1360) - 420 (preview) - 16 (2 gaps) = 412px.
      expect(railAside.style.getPropertyValue('--kiki-rail-width')).toBe('412px');
    } finally {
      innerWidthSpy.mockRestore();
    }
  });
});

describe('RightRail plugin preview routing and branch-owned rail', () => {
  it('opens a PreviewWorkspace plugin tab when clicking a Right Rail inspector-tab slot instead of embedding an inline panel', async () => {
    pluginSlotsHolder.current = [{
      pluginId: 'kiki-phone',
      pluginVersion: '0.3.2',
      id: 'phone-preview-inspector',
      slot: 'inspector-tab',
      title: { default: 'Phone', zh: '手机', en: 'Phone' },
      panelId: 'phone-preview',
      entryUrl: '/api/plugins/kiki-phone/ui/preview.html',
    }];
    const openPluginPanel = vi.fn();
    const { MediaPreviewContext } = await import('./mediaPreviewContext');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <MediaPreviewContext.Provider
              value={{
                openPluginPanel,
                activePluginPanelKey: 'kiki-phone:phone-preview',
              } as never}
            >
              <RightRail
                state={{ ...createViewState('sess-1'), tasks: [] }}
                forest={forest}
                onCancelTask={() => {}}
                onStopAgentTask={async () => {}}
                onOpenSubagent={() => {}}
              />
            </MediaPreviewContext.Provider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('[data-plugin-inspector-open="kiki-phone:phone-preview"]')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(openPluginPanel).not.toHaveBeenCalled();
  });

  it('scopes a routed Branch page Right Rail to the branch itself and shows subagents spawned by the branch', async () => {
    const branchForest = buildAgentForest([], [
      { agentId: 'main', name: 'Main', status: 'idle', busy: false },
      {
        agentId: 'branch-281',
        parentAgentId: 'main',
        name: 'rail_polish',
        label: 'Polish right rail',
        isBranch: true,
        branchSeed: 'compact',
        branchSealed: false,
        status: 'running',
        busy: true,
      },
    ]);
    const onStopAgentTask = vi.fn(async () => {});
    const onOpenSubagent = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <I18nProvider>
            <RightRail
              state={{
                ...createViewState('sess-1'),
                loaded: true,
                busy: true,
                blocks: [{
                  kind: 'subagent',
                  id: 'subagent:agent-285',
                  subagentId: 'agent-285',
                  parentAgentId: 'branch-281',
                  parentToolCallId: 'call-285',
                  name: 'reviewer',
                  label: 'Independent review',
                  description: 'Independent review',
                  model: undefined,
                  thinkingEffort: undefined,
                  status: 'running',
                  summary: undefined,
                  error: undefined,
                  endedAt: undefined,
                  toolCallCount: 0,
                  transcript: [],
                }],
                tasks: [{
                  id: 'task-285',
                  session_id: 'sess-1',
                  kind: 'subagent',
                  agent_id: 'agent-285',
                  description: 'Independent review',
                  status: 'running',
                  created_at: '2026-01-01T00:05:00.000Z',
                }],
              }}
              forest={branchForest}
              selectedAgentId="branch-281"
              subagent={{
                agentId: 'branch-281',
                block: undefined,
                pendingInteractionCount: 0,
                onJumpToSpawn: () => {},
              }}
              taskOwnerAgentId="branch-281"
              onCancelTask={() => {}}
              onStopAgentTask={onStopAgentTask}
              onOpenSubagent={onOpenSubagent}
            />
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    // Routed branch page keeps the Branches switcher accessible so users can jump between branches or back to main,
    // while main-only cron & persona settings stay out of the branch rail.
    expect(container.querySelector('[data-rail-section="branches"]')).not.toBeNull();
    expect(container.querySelector('[data-rail-session-cron]')).toBeNull();
    expect(container.querySelector('[data-rail-persona-settings]')).toBeNull();

    // Overview belongs to branch-281 (not main) in default mode
    const overviewDefault = container.querySelector('[data-panel-props="overview"]')!;
    expect(overviewDefault.getAttribute('data-panel-agent')).toBe('branch-281');
    expect(overviewDefault.getAttribute('data-panel-scope-root')).toBe('branch-281');

    // Subagent spawned by branch-281 appears live in branch-281's roster
    expect(container.querySelector('[data-inspector-agents]')).not.toBeNull();
    expect(container.textContent).toContain('Independent review');

    // Switching to Config tab on a routed branch keeps session-wide controls hidden
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-rail-tab="config"]')!.click();
    });
    expect(container.querySelector('[data-rail-session-cron]')).toBeNull();
    expect(container.querySelector('[data-rail-persona-settings]')).toBeNull();
    expect(container.querySelector('[data-rail-config-topology]')).not.toBeNull();
  });

  it('aligns Agents header and ended group counts when session branches are excluded from agentCounts', async () => {
    const forest = buildAgentForest([], [
      { agentId: 'main', name: 'Main' },
      { agentId: 'branch-1', parentAgentId: 'main', name: 'Side branch', status: 'completed', isBranch: true, branchSealed: true },
      ...Array.from({ length: 6 }, (_, index) => ({
        agentId: `worker-${index}`,
        parentAgentId: 'main',
        name: `Worker ${index}`,
        status: 'completed' as const,
      })),
    ]);
    const rail = await renderRail({
      agentForest: forest,
      stateOverrides: {
        agentCounts: { total: 541, subagents: 540, active: 0, idle: 0, unknown: 0, completed: 540, failed: 0, cancelled: 0 },
      },
    });
    const agents = rail.querySelector('[data-inspector-agents]')!;
    expect(agents.textContent).toContain('539');
    expect(agents.textContent).not.toContain('540');
    expect(agents.querySelector('[data-roster-done-group]')?.textContent).toContain('539');
    expect(agents.querySelector('[data-roster-summary]')).toBeNull();
  });
});
