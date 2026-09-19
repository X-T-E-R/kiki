// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createViewState, type AgentForest, type AgentTreeNode, type SessionViewState } from '@kiki/session-core/session';
import { UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { I18nProvider } from '../i18n';
import { AgentPanelContainer } from './AgentPanelContainer';

/**
 * The panel must read every agent-scoped field from the tab's OWN agent, which
 * it resolves through the session's live controller registry — never from the
 * routed `state` prop (that view belongs to whatever agent the session page is
 * showing). The harness therefore publishes a fake registry of per-agent view
 * states while the `state` prop always carries another agent's data ("routed
 * agent todo"), so a panel rendering that checklist for a different agentId is
 * caught borrowing it. `registry.holder.value = null` simulates "no live
 * connection", where nothing agent-scoped exists at all.
 */
const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const agents: Record<string, unknown> = {};
  const controller = {
    sessionId: 'session',
    getState: () => agents['main'],
    getAgentState: (agentId: string) => agents[agentId],
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeAgent: (_agentId: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const registry = {
    add: () => undefined,
    delete: () => undefined,
    [Symbol.iterator]: () => [controller][Symbol.iterator](),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => 0,
  };
  return {
    agents,
    registry,
    /** What the mocked `useOptionalControllerRegistry` hands back per render. */
    holder: { value: registry as unknown },
    emit: () => { for (const listener of listeners) listener(); },
    getAgentCapabilities: vi.fn(),
    getAgentPlan: vi.fn(),
  };
});
const { getAgentCapabilities, getAgentPlan } = harness;

vi.mock('../state/connection', () => ({
  useOptionalControllerRegistry: () => harness.holder.value,
  useConnection: () => ({
    klient: {
      global: { agentPanel: { read: (query: unknown, options: { signal: AbortSignal }) => harness.getAgentCapabilities(query, options.signal) } },
      session: (_sessionId: string) => ({
        agent: (agentId: string) => ({ getPlan: () => harness.getAgentPlan(agentId) }),
      }),
    },
  }),
}));

function viewState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return { ...createViewState('session'), loaded: true, ...overrides };
}

function todo(title: string, status = 'pending'): SessionViewState['todos'][number] {
  return { title, status };
}

/** The routed view — another agent's data, which no panel may present as its own. */
function routedState(overrides: Partial<SessionViewState> = {}): SessionViewState {
  return viewState({ todos: [todo('routed agent todo')], ...overrides });
}

function forestOf(agentIds: readonly string[]): AgentForest {
  const nodes: AgentTreeNode[] = agentIds.map((agentId) => ({
    agentId, name: agentId, label: agentId, status: 'completed', busy: false,
    toolCallCount: 0, childIds: [],
  }));
  return { roots: nodes, byId: Object.fromEntries(nodes.map((node) => [node.agentId, node])) };
}

let root: Root;
let element: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
  getAgentCapabilities.mockReset();
  getAgentPlan.mockReset();
  getAgentPlan.mockResolvedValue(null);
  for (const agentId of Object.keys(harness.agents)) delete harness.agents[agentId];
  harness.agents['main'] = viewState();
  harness.holder.value = harness.registry;
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  element.remove();
});

async function render(agentId: string, options: { routed?: SessionViewState; forest?: AgentForest } = {}) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><I18nProvider>
    <AgentPanelContainer state={options.routed ?? routedState()} forest={options.forest ?? forestOf([agentId])} agentId={agentId} />
  </I18nProvider></MemoryRouter></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((done) => setTimeout(done, 0));
  });
}

function todosStatus(): string | undefined {
  return element.querySelector<HTMLElement>('[data-agent-todos-status]')?.dataset['agentTodosStatus'];
}

it('queries the selected identity, keeps missing billing unknown and does not reuse another agent todo', async () => {
  getAgentCapabilities.mockImplementation(async (query) => ({
    context: 'live', owner: { agent_id: query.agent_id }, available: false, targets: [], tools: [], skills: [],
    profile: { name: query.agent_id === 'main' ? 'leader' : 'researcher', source: 'definition:fixture' },
    metrics: { [query.agent_id]: UNKNOWN_AGENT_PANEL_METRICS },
  }));
  harness.agents['main'] = viewState({ todos: [todo('main private todo')] });
  harness.agents['child'] = viewState({ todos: [todo('child todo')] });
  await render('main');
  expect(element.textContent).toContain('main private todo');
  expect(element.textContent).not.toContain('routed agent todo');
  await render('child');
  expect(getAgentCapabilities).toHaveBeenLastCalledWith({ session_id: 'session', agent_id: 'child' }, expect.any(AbortSignal));
  expect(element.textContent).toContain('child todo');
  expect(element.textContent).not.toContain('main private todo');
  expect(element.textContent).not.toContain('routed agent todo');
  expect(element.textContent).toContain('researcher');
  expect(element.textContent).toContain('未知');
  expect(element.textContent).not.toContain('$0');
});

it('labels forced effort, detached routes and temporary profile files', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: true, targets: [], tools: [], skills: [],
    profile: {
      name: 'temporary-reviewer', model: 'review-model', thinking_effort: 'max',
      thinking_effort_source: 'forced', route_detached: true, profile_source: 'profile-file',
    },
    metrics: { child: UNKNOWN_AGENT_PANEL_METRICS },
  });
  harness.agents['child'] = viewState();

  await render('child');

  expect(element.querySelector('[data-thinking-effort-source="forced"]')?.textContent).toBe('强制');
  expect(element.querySelector('[data-route-status="detached"]')?.textContent).toBe('路由已脱离');
  expect(element.querySelector('[data-profile-source="profile-file"]')?.textContent).toBe('临时文件');
});

it('shows dispatch policy, recommendation and advisory deviation badges, including unknown legacy fields', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: true, tools: [], skills: [],
    targets: [
      {
        profile: 'reviewer', executor: 'native', defaults_available: true,
        dispatch_policy: 'advisory', recommendation_status: 'allowed_nonpreferred', advisory_deviation: true,
      },
      {
        profile: 'preferred', executor: 'native', defaults_available: true,
        dispatch_policy: 'strict', recommendation_status: 'preferred', advisory_deviation: false,
      },
      {
        profile: 'blocked', executor: 'native', defaults_available: true,
        dispatch_policy: 'strict', recommendation_status: 'blocked', advisory_deviation: false,
      },
      {
        profile: 'unconfigured', executor: 'native', defaults_available: true,
        dispatch_policy: 'advisory', recommendation_status: 'unconfigured', advisory_deviation: false,
      },
      { profile: 'legacy', executor: 'native', defaults_available: true },
    ],
    profile: { name: 'caller' }, metrics: { child: UNKNOWN_AGENT_PANEL_METRICS },
  });
  harness.agents['child'] = viewState();

  await render('child');

  expect(element.querySelector('[data-dispatch-policy="advisory"]')?.textContent).toBe('建议模式');
  expect(element.querySelector('[data-dispatch-policy="strict"]')?.textContent).toBe('严格模式');
  expect(element.querySelector('[data-recommendation-status="allowed_nonpreferred"]')?.textContent).toBe('允许偏离推荐名单');
  expect(element.querySelector('[data-recommendation-status="preferred"]')?.textContent).toBe('推荐目标');
  expect(element.querySelector('[data-recommendation-status="blocked"]')?.textContent).toBe('当前禁止启动');
  expect(element.querySelector('[data-recommendation-status="unconfigured"]')?.textContent).toBe('未报告');
  expect(element.querySelector('[data-advisory-deviation="true"]')).not.toBeNull();
  expect(element.querySelector('[data-advisory-deviation="false"]')).not.toBeNull();
  expect(element.querySelector('[data-dispatch-policy="unknown"]')?.textContent).toBe('未报告');
  expect(element.querySelector('[data-advisory-deviation="unknown"]')?.textContent).toBe('未报告');
});

it('reports unknown instead of the routed agent todo when the tab agent has no data', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'ghost' }, available: false, targets: [], tools: [], skills: [], metrics: {},
  });
  harness.agents['main'] = viewState({ todos: [todo('main private todo')] });
  await render('ghost', { forest: forestOf(['main']) });
  expect(todosStatus()).toBe('unknown');
  expect(element.querySelector('[data-agent-todo-section]')).toBeNull();
  expect(element.textContent).not.toContain('main private todo');
  expect(element.textContent).not.toContain('routed agent todo');
});

it('reports unknown rather than another agent todo when no live controller owns the session', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: false, targets: [], tools: [], skills: [], metrics: {},
  });
  harness.agents['child'] = viewState({ todos: [todo('child todo')] });
  harness.holder.value = null;
  await render('child');
  expect(todosStatus()).toBe('unknown');
  expect(element.querySelector('[data-agent-todo-section]')).toBeNull();
  expect(element.textContent).not.toContain('child todo');
  expect(element.textContent).not.toContain('routed agent todo');
});

it('keeps the loading placeholder, not another agent todo, while the tab agent state is unloaded', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: false, targets: [], tools: [], skills: [], metrics: {},
  });
  harness.agents['child'] = viewState({ loaded: false, todos: [] });
  await render('child');
  expect(todosStatus()).toBe('loading');
  expect(element.querySelector('[data-agent-todo-section]')).toBeNull();
  expect(element.textContent).not.toContain('routed agent todo');
});

it('polls on the tab agent own activity and stops once that agent settles', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: true, targets: [],
    tools: [], skills: [], metrics: { child: UNKNOWN_AGENT_PANEL_METRICS } });
  harness.agents['child'] = viewState({ busy: true });
  vi.useFakeTimers();
  try {
    await render('child', { routed: routedState({ busy: false }) });
    const initial = getAgentCapabilities.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    expect(getAgentCapabilities.mock.calls.length).toBeGreaterThan(initial);
    harness.agents['child'] = viewState({ busy: false });
    await act(async () => { harness.emit(); });
    const settled = getAgentCapabilities.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getAgentCapabilities).toHaveBeenCalledTimes(settled);
  } finally {
    vi.useRealTimers();
  }
});

it('does not poll a settled tab agent just because the routed agent is busy', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: true, targets: [],
    tools: [], skills: [], metrics: { child: UNKNOWN_AGENT_PANEL_METRICS } });
  harness.agents['child'] = viewState({ busy: false });
  vi.useFakeTimers();
  try {
    await render('child', { routed: routedState({ busy: true }) });
    const initial = getAgentCapabilities.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getAgentCapabilities).toHaveBeenCalledTimes(initial);
  } finally {
    vi.useRealTimers();
  }
});

it('does not keep polling a settled historical agent', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: false, targets: [] });
  harness.agents['child'] = viewState({ busy: false });
  await render('child');
  expect(getAgentCapabilities).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getAgentCapabilities).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the current plan agent-scoped, collapsed by default, and expandable', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: false, targets: [], tools: [], skills: [], metrics: { main: UNKNOWN_AGENT_PANEL_METRICS } });
  getAgentPlan.mockImplementation(async (agentId: string) => ({
    id: `${agentId}-plan`,
    content: agentId === 'main' ? '# Main plan\n- Main only' : '# Child plan\n- Child only',
    path: `/fixture/${agentId}/PLAN.md`,
  }));
  harness.agents['main'] = viewState({ planMode: false });
  harness.agents['child'] = viewState({ planMode: false });

  // The routed agent is in plan mode; the panel's plan query must still be
  // keyed on the tab agent's own plan mode.
  await render('main', { routed: routedState({ planMode: true }) });
  const mainPlan = element.querySelector<HTMLElement>('[data-agent-plan]');
  expect(mainPlan).not.toBeNull();
  expect(mainPlan?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(mainPlan?.textContent).not.toContain('Main only');
  await act(async () => { mainPlan?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(element.textContent).toContain('Main only');

  await render('child', { routed: routedState({ planMode: true }) });
  expect(getAgentPlan).toHaveBeenLastCalledWith('child');
  const planQueryKey = queryClient.getQueryCache().getAll()
    .map((query) => query.queryKey)
    .find((key) => key[0] === 'agentPlan' && key[2] === 'child');
  expect(planQueryKey).toEqual(['agentPlan', 'session', 'child', false]);
  const childPlan = element.querySelector<HTMLElement>('[data-agent-plan]');
  expect(childPlan?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(element.textContent).not.toContain('Child only');
  await act(async () => { childPlan?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(element.textContent).toContain('Child only');
  expect(element.textContent).not.toContain('Main only');
});

it('shows a recoverable query error instead of silently presenting an empty capability catalog', async () => {
  getAgentCapabilities.mockRejectedValue(new Error('fixture unavailable'));
  harness.agents['child'] = viewState({ todos: [todo('kept local todo')] });
  await render('child');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('fixture unavailable');
  expect(element.textContent).toContain('kept local todo');
});

it('renders cache hit rate percentage on single agent and aggregated on agent tree', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live',
    owner: { agent_id: 'main' },
    available: true,
    targets: [],
    tools: [],
    skills: [],
    profile: { name: 'main-agent', source: 'definition:fixture' },
    metrics: {
      main: {
        ...UNKNOWN_AGENT_PANEL_METRICS,
        inputTokens: 100,
        cacheReadTokens: 68,
        cacheWriteTokens: 10,
        totalTokens: 120,
        totalCostUsd: 0.05,
      },
      child: {
        ...UNKNOWN_AGENT_PANEL_METRICS,
        inputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        totalTokens: 250,
        totalCostUsd: 0.10,
      },
    },
  });

  await render('main', { forest: forestOf(['main', 'child']) });

  // Single agent cache rate: 68 / 100 = 68%
  expect(element.textContent).toContain('缓存率:68%');

  // Tree cache rate: (68 + 100) / (100 + 200) = 168 / 300 = 56%
  const treeMetrics = element.querySelector('[data-tree-metrics]');
  expect(treeMetrics).not.toBeNull();
  expect(treeMetrics?.textContent).toContain('整树缓存率:56%');
});
