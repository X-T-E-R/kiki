// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorCode } from '@kiki/protocol';
import { ApiError } from '@kiki/session-core/transport';
import { createViewState, SessionController, type AgentForest, type AgentTreeNode, type SessionViewState } from '@kiki/session-core/session';
import type { SessionTransport } from '@kiki/session-core/transport';
import type { SessionViewFacade } from '@kiki/klient/session-view';
import { AgentTranscript, type AgentTranscriptSnapshot, type ContentRef, type ContentSegment, type TranscriptOperation, type TranscriptTodo } from '@kiki/transcript';
import { boundedTranscriptSnapshot, boundedTranscriptOps } from '../../../../packages/kap-server/src/transport/klient/boundedTranscript';
import { boundedEntity, readContentSegment } from '../../../../packages/kap-server/src/transport/klient/boundedContent';
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
  const releaseTodoRead = vi.fn();
  const retryTodoRead = vi.fn();
  const beginContentRead = vi.fn(() => ({ release: releaseTodoRead, retry: retryTodoRead }));
  const loadTranscriptEntities = vi.fn();
  const controller = {
    beginContentRead,
    loadTranscriptEntities,
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
    beginContentRead,
    releaseTodoRead,
    retryTodoRead,
    loadTranscriptEntities,
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
  harness.beginContentRead.mockClear();
  harness.releaseTodoRead.mockClear();
  harness.retryTodoRead.mockClear();
  harness.loadTranscriptEntities.mockReset();
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

async function render(agentId: string, options: {
  routed?: SessionViewState; forest?: AgentForest; visible?: boolean;
  part?: 'all' | 'work' | 'usage' | 'overview' | 'profile';
  overviewMode?: 'default' | 'cockpit';
  renderOverview?: Parameters<typeof AgentPanelContainer>[0]['renderOverview'];
} = {}) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><I18nProvider>
    <AgentPanelContainer state={options.routed ?? routedState()} forest={options.forest ?? forestOf([agentId])} agentId={agentId} visible={options.visible} part={options.part} overviewMode={options.overviewMode} renderOverview={options.renderOverview} />
  </I18nProvider></MemoryRouter></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((done) => setTimeout(done, 0));
  });
}

function todosStatus(): string | undefined {
  return element.querySelector<HTMLElement>('[data-agent-todos-status]')?.dataset['agentTodosStatus'];
}

it('defers agent panel reads until visible and stops reads while hidden', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: false,
    targets: [], tools: [], skills: [], metrics: {},
  });
  await render('child', { visible: false });
  expect(getAgentCapabilities).not.toHaveBeenCalled();
  await render('child', { visible: true });
  expect(getAgentCapabilities).toHaveBeenCalledTimes(1);
  await render('child', { visible: false });
  expect(getAgentCapabilities).toHaveBeenCalledTimes(1);
});

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
  // Missing billing stays unknown: the inspector hides the row rather than
  // inventing a $0 figure.
  expect(element.textContent).not.toContain('费用');
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
        dispatch_policy: 'fixed', recommendation_status: 'allowed_nonpreferred', advisory_deviation: true,
      },
      {
        profile: 'preferred', executor: 'native', defaults_available: true,
        dispatch_policy: 'fixed', recommendation_status: 'preferred', advisory_deviation: false,
      },
      {
        profile: 'blocked', executor: 'native', defaults_available: true,
        dispatch_policy: 'fixed', recommendation_status: 'blocked', advisory_deviation: false,
      },
      {
        profile: 'unconfigured', executor: 'native', defaults_available: true,
        dispatch_policy: 'fixed', recommendation_status: 'unconfigured', advisory_deviation: false,
      },
      { profile: 'legacy', executor: 'native', defaults_available: true },
    ],
    profile: { name: 'caller' }, metrics: { child: UNKNOWN_AGENT_PANEL_METRICS },
  });
  harness.agents['child'] = viewState();

  await render('child');

  expect(element.querySelector('[data-dispatch-policy="fixed"]')?.textContent).toBe('由策略固定');
  expect(element.querySelector('[data-dispatch-policy="fixed"]')?.textContent).toBe('由策略固定');
  expect(element.querySelector('[data-recommendation-status="allowed_nonpreferred"]')?.textContent).toBe('允许偏离推荐名单');
  expect(element.querySelector('[data-recommendation-status="preferred"]')?.textContent).toBe('推荐目标');
  expect(element.querySelector('[data-recommendation-status="blocked"]')?.textContent).toBe('当前禁止启动');
  expect(element.querySelector('[data-recommendation-status="unconfigured"]')?.textContent).toBe('未配置推荐');
  expect(element.querySelector('[data-advisory-deviation="true"]')).not.toBeNull();
  expect(element.querySelector('[data-advisory-deviation="false"]')).not.toBeNull();
  expect(element.querySelector('[data-dispatch-policy="unknown"]')?.textContent).toBe('未报告');
  expect(element.querySelector('[data-advisory-deviation="unknown"]')?.textContent).toBe('未报告');
});

it('uses the profile policy when the caller has no dispatch targets', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: true, targets: [], tools: [], skills: [],
    profile: { name: 'general', can_spawn_subagents: false },
    metrics: { child: UNKNOWN_AGENT_PANEL_METRICS },
  });
  harness.agents['child'] = viewState();

  await render('child');

  expect(element.querySelector('[data-dispatch-policy="fixed"]')?.textContent).toBe('由策略固定');
  expect(element.querySelector('[data-dispatch-policy="unknown"]')).toBeNull();
  expect(element.querySelector('[data-recommendation-status="unknown"]')?.textContent).toBe('未报告');
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
    expect(getAgentCapabilities).toHaveBeenCalledTimes(initial);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
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

it('defers signature refresh while the metrics request is running instead of aborting and restarting it', async () => {
  let resolve!: (value: unknown) => void;
  getAgentCapabilities.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: true,
    targets: [], tools: [], skills: [], metrics: { child: UNKNOWN_AGENT_PANEL_METRICS } });
  harness.agents['child'] = viewState({ profile: 'first' });
  await render('child');
  const signal = getAgentCapabilities.mock.calls[0]?.[1] as AbortSignal;
  harness.agents['child'] = viewState({ profile: 'second' });
  await act(async () => { harness.emit(); });
  harness.agents['child'] = viewState({ profile: 'third' });
  await act(async () => { harness.emit(); });
  expect(getAgentCapabilities).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(false);
  await act(async () => { resolve({ context: 'live', owner: { agent_id: 'child' }, available: true,
    targets: [], tools: [], skills: [], metrics: { child: UNKNOWN_AGENT_PANEL_METRICS } }); });
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  expect(getAgentCapabilities).toHaveBeenCalledTimes(2);
  expect(signal.aborted).toBe(false);
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

it('reads a plan only after the tab agent is loaded, settled, and known to be in plan mode', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'persisted', owner: { agent_id: 'child' }, available: false, targets: [], tools: [], skills: [], metrics: {} });
  getAgentPlan.mockResolvedValue({ id: 'child-plan', content: '# Child plan', path: '/fixture/child/PLAN.md' });
  harness.agents['child'] = viewState({ planMode: undefined });
  await render('child', { routed: routedState({ planMode: true }) });
  expect(getAgentPlan).not.toHaveBeenCalled();
  harness.agents['child'] = viewState({ planMode: false });
  await render('child', { routed: routedState({ planMode: true }) });
  expect(getAgentPlan).not.toHaveBeenCalled();
  harness.agents['child'] = viewState({ planMode: true, loaded: false });
  await render('child');
  expect(getAgentPlan).not.toHaveBeenCalled();
  harness.agents['child'] = viewState({ planMode: true, resyncing: true });
  await render('child');
  expect(getAgentPlan).not.toHaveBeenCalled();
  harness.agents['child'] = viewState({ planMode: true });
  await render('child', { routed: routedState({ planMode: false }) });
  expect(getAgentPlan).toHaveBeenCalledExactlyOnceWith('child');
  expect(element.querySelector('[data-agent-plan]')).not.toBeNull();
});

it('keeps the current plan agent-scoped, collapsed by default, and expandable', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: false, targets: [], tools: [], skills: [], metrics: { main: UNKNOWN_AGENT_PANEL_METRICS } });
  getAgentPlan.mockImplementation(async (agentId: string) => ({
    id: `${agentId}-plan`,
    content: agentId === 'main' ? '# Main plan\n- Main only' : '# Child plan\n- Child only',
    path: `/fixture/${agentId}/PLAN.md`,
  }));
  harness.agents['main'] = viewState({ planMode: true });
  harness.agents['child'] = viewState({ planMode: true });

  // The routed agent is not in plan mode; the panel's plan query must still be
  // keyed on the tab agent's own plan mode.
  await render('main', { routed: routedState({ planMode: false }) });
  const mainPlan = element.querySelector<HTMLElement>('[data-agent-plan]');
  expect(mainPlan).not.toBeNull();
  expect(mainPlan?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(mainPlan?.textContent).not.toContain('Main only');
  await act(async () => { mainPlan?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(element.textContent).toContain('Main only');

  await render('child', { routed: routedState({ planMode: false }) });
  expect(getAgentPlan).toHaveBeenLastCalledWith('child');
  const planQueryKey = queryClient.getQueryCache().getAll()
    .map((query) => query.queryKey)
    .find((key) => key[0] === 'agentPlan' && key[2] === 'child');
  expect(planQueryKey).toEqual(['agentPlan', 'session', 'child', true]);
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

it('localizes known capability-query API errors', async () => {
  getAgentCapabilities.mockRejectedValue(new ApiError({
    code: ErrorCode.AGENT_PROFILE_NOT_FOUND,
    msg: 'profile missing from server',
    data: null,
  }));
  harness.agents['child'] = viewState();
  await render('child');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('无法加载 Agent 能力：找不到 Agent 配置档。');
  expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('profile missing from server');
});

it('does not label main-only persisted usage as a complete agent-tree total', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: { main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 120, totalCostUsd: 0.05,
      inputTokens: 100, cacheReadTokens: 68 } },
  });
  await render('main', { forest: forestOf(['main', 'child']) });
  // Only main's usage is persisted, so no tree-wide total is claimed at all.
  expect(element.querySelector('[data-tree-metrics]')?.textContent ?? '').not.toContain('整树总 Tokens');
  expect(element.querySelector('[data-tree-metrics]')?.textContent ?? '').not.toContain('整树缓存率');
  expect(element.textContent).toContain('缓存率68%');
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
  expect(element.textContent).toContain('缓存率68%');

  // Tree cache rate: (68 + 100) / (100 + 200) = 168 / 300 = 56%
  const treeMetrics = element.querySelector('[data-tree-metrics]');
  expect(treeMetrics).not.toBeNull();
  expect(treeMetrics?.textContent).toContain('整树缓存率56%');
});

const notesMeta = { rev: 4, hash: 'h', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'msg-9', windowEpoch: 2 };

it('shows each agent its own working notes in the work part, never the routed agent\'s', async () => {
  harness.agents['main'] = viewState({ todoNotes: { goal: 'Main goal', next: 'Main next' }, todoNotesMeta: notesMeta });
  harness.agents['child'] = viewState({ todoNotes: { goal: 'Child goal' }, todoNotesMeta: { ...notesMeta, rev: 1 } });
  const routed = routedState({ todoNotes: { goal: 'Routed goal' }, todoNotesMeta: notesMeta });

  await render('main', { part: 'work', routed });
  expect(element.textContent).toContain('Main goal');
  expect(element.textContent).not.toContain('Routed goal');
  expect(element.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('written');

  await render('child', { part: 'work', routed });
  expect(element.textContent).toContain('Child goal');
  expect(element.textContent).not.toContain('Main goal');
  expect(element.textContent).not.toContain('Routed goal');
});

it('tells a still-loading agent from one that has no notes', async () => {
  harness.agents['child'] = viewState({ loaded: false, todos: [] });
  await render('child', { part: 'work' });
  expect(element.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('loading');
  expect(element.textContent).toContain('正在读取工作笔记…');
  expect(element.textContent).not.toContain('还没有工作笔记');

  harness.agents['child'] = viewState({ todos: [] });
  await render('child', { part: 'work' });
  expect(element.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
  expect(element.textContent).toContain('还没有工作笔记。');
  expect(element.textContent).not.toContain('正在读取工作笔记');
});

it('settles to the empty state when the agent clears its notes', async () => {
  harness.agents['child'] = viewState({ todoNotes: { goal: 'Temporary goal' }, todoNotesMeta: notesMeta });
  await render('child', { part: 'work' });
  expect(element.textContent).toContain('Temporary goal');
  harness.agents['child'] = viewState({ todos: [] });
  await act(async () => { harness.emit(); });
  expect(element.textContent).not.toContain('Temporary goal');
  expect(element.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
});

it('keeps the notes section out when no live controller owns the session', async () => {
  harness.holder.value = null;
  await render('main', { part: 'work' });
  expect(element.querySelector('[data-agent-notes-section]')).toBeNull();
});

const renderOverviewLayout = (body: React.ReactNode, scopeSwitch: React.ReactNode) => (
  <><header data-overview-test-head><h3>Overview</h3>{scopeSwitch}</header><div data-overview-test-body>{body}</div></>
);

it.each([
  ['zh', '本智能体', '全树', '整棵智能体树'],
  ['en', 'This agent', 'Tree', 'Whole tree'],
])('renders the %s short scope labels in the supplied header and keeps the scope interactive', async (locale, agentLabel, treeLabel, fullTreeLabel) => {
  localStorage.setItem('kiki.locale', locale);
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: {
      main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 120, totalCostUsd: 0.05 },
      child: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 250, totalCostUsd: 0.10 },
    },
  });
  await render('main', { part: 'overview', forest: forestOf(['main', 'child']), renderOverview: renderOverviewLayout });
  const head = element.querySelector('[data-overview-test-head]')!;
  const agent = head.querySelector<HTMLButtonElement>('[data-usage-scope="agent"]')!;
  const tree = head.querySelector<HTMLButtonElement>('[data-usage-scope="tree"]')!;
  expect(agent.textContent).toBe(agentLabel);
  expect(tree.textContent).toBe(treeLabel);
  expect(tree.getAttribute('aria-label')).toBe(fullTreeLabel);
  expect(tree.title).toBe(fullTreeLabel);
  expect(head.querySelector('[role="radiogroup"]')?.classList.contains('min-w-0')).toBe(true);
  expect(agent.classList.contains('truncate')).toBe(true);
  expect(tree.classList.contains('shrink-0')).toBe(true);
  expect(element.querySelector('[data-overview-test-body] [role="radiogroup"]')).toBeNull();
  expect(element.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.05');
  await act(async () => { tree.click(); });
  expect(tree.getAttribute('aria-checked')).toBe('true');
  expect(agent.getAttribute('aria-checked')).toBe('false');
  expect(element.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.15');
  await act(async () => { agent.click(); });
  expect(agent.getAttribute('aria-checked')).toBe('true');
  expect(element.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.05');
});

it('keeps the supplied overview header without a scope switch for children and cockpit mode', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'child' }, available: true, targets: [], tools: [], skills: [], metrics: {},
  });
  await render('child', { part: 'overview', renderOverview: renderOverviewLayout });
  expect(element.querySelector('[data-overview-test-head] h3')).not.toBeNull();
  expect(element.querySelector('[role="radiogroup"]')).toBeNull();
  await render('main', { part: 'overview', overviewMode: 'cockpit', renderOverview: renderOverviewLayout });
  expect(element.querySelector('[data-overview-test-head] h3')).not.toBeNull();
  expect(element.querySelector('[role="radiogroup"]')).toBeNull();
  expect(element.querySelector('[data-cockpit-overview]')).not.toBeNull();
});

it('keeps the tree scope standing on main even when it has no children', async () => {
  // Main alone: there is nothing to sum, but the control is the standing scope
  // of these figures and must not blink out on a cold open.
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: { main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 1_200, totalCostUsd: 0.05 } },
  });
  await render('main', { part: 'overview', forest: forestOf(['main']), renderOverview: renderOverviewLayout });
  const head = element.querySelector('[data-overview-test-head]')!;
  const agent = head.querySelector<HTMLButtonElement>('[data-usage-scope="agent"]')!;
  const tree = head.querySelector<HTMLButtonElement>('[data-usage-scope="tree"]')!;
  expect(agent).not.toBeNull();
  expect(tree).not.toBeNull();
  expect(tree.disabled).toBe(false);
  // A one-agent tree is fully counted: the total really is main's own, so
  // nothing is marked incomplete and no caveat is printed.
  expect(tree.hasAttribute('data-usage-scope-incomplete')).toBe(false);
  expect(element.querySelector('[data-overview-tree-incomplete]')).toBeNull();
  await act(async () => { tree.click(); });
  expect(element.querySelector('[data-tree-metrics]')).not.toBeNull();
  expect(element.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.05');
});

it('marks the tree scope incomplete while a child has not reported, and says so in words', async () => {
  // The cold-open case the rail used to hide: a child exists in the forest but
  // the server has sent no metrics row for it. The switch stays, the summed
  // numbers are marked partial, and the caveat says what was left out.
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: { main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 1_200, totalCostUsd: 0.05 } },
  });
  await render('main', { part: 'overview', forest: forestOf(['main', 'child']), renderOverview: renderOverviewLayout });
  const tree = () => element.querySelector<HTMLButtonElement>('[data-overview-test-head] [data-usage-scope="tree"]')!;
  expect(tree().hasAttribute('data-usage-scope-incomplete')).toBe(true);
  expect(tree().disabled).toBe(false);
  expect(tree().title).toContain('尚未上报');
  // Switching to the tree really changes the scope, and the caveat travels
  // with it. The sum is the real one over the agents that reported — main's
  // 1.2k here — and the row says which agents it could not count, rather
  // than passing 1.2k off as the whole tree or inventing a total.
  await act(async () => { tree().click(); });
  expect(tree().getAttribute('aria-checked')).toBe('true');
  const note = element.querySelector<HTMLElement>('[data-overview-tree-incomplete]');
  expect(note?.textContent).toContain('仍在统计中');
  expect(element.querySelector('[data-tree-metrics]')).not.toBeNull();
  expect(element.querySelector('[data-overview-fact="tokens"]')?.textContent).toContain('1.2k');
  // Back on the agent scope the caveat is gone and the real count returns.
  await act(async () => { element.querySelector<HTMLButtonElement>('[data-usage-scope="agent"]')!.click(); });
  expect(element.querySelector('[data-overview-tree-incomplete]')).toBeNull();
  expect(element.querySelector('[data-agent-usage]')).not.toBeNull();
});

it('shows the tree total when every agent has reported, and no caveat', async () => {
  // The positive case: a full metrics map really is summed and really switches.
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: {
      main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 1_200, totalCostUsd: 0.05 },
      child: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 3_400, totalCostUsd: 0.10 },
    },
  });
  await render('main', { part: 'overview', forest: forestOf(['main', 'child']), renderOverview: renderOverviewLayout });
  const tree = () => element.querySelector<HTMLButtonElement>('[data-overview-test-head] [data-usage-scope="tree"]')!;
  expect(tree().hasAttribute('data-usage-scope-incomplete')).toBe(false);
  await act(async () => { tree().click(); });
  expect(element.querySelector('[data-tree-metrics]')).not.toBeNull();
  expect(element.querySelector('[data-overview-fact="tokens"]')?.textContent).toContain('4.6k');
  expect(element.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.15');
  expect(element.querySelector('[data-overview-tree-incomplete]')).toBeNull();
});

it('keeps the permission mode out of the overview; the composer and profile own it', async () => {
  getAgentCapabilities.mockResolvedValue({
    context: 'live', owner: { agent_id: 'main' }, available: true, targets: [], tools: [], skills: [],
    metrics: { main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 1_200, totalCostUsd: 0.05 } },
  });
  harness.agents['main'] = viewState({ permissionMode: 'yolo' });
  await render('main', { part: 'overview' });
  // "完全放行" / "自动" / "权限" belong to the composer's permission chip and
  // the profile card, never below the overview's numbers.
  expect(element.querySelector('[data-overview-setup]')).toBeNull();
  expect(element.textContent).not.toContain('完全放行');
  expect(element.textContent).not.toContain('权限');
});

const todoItemsRef: NonNullable<SessionViewState['contentRefs']>[number] = {
  source: { kind: 'todo', id: 'todo' }, path: ['items'], kind: 'array', offset: 0, total: 14, revision: 'todo-revision',
};

it('reads only the selected todo items and renders the complete list without waiting for history', async () => {
  harness.agents['main'] = viewState({ todos: [], contentRefs: [todoItemsRef], hasMoreHistory: true });
  await render('main', { part: 'work' });
  expect(todosStatus()).toBe('loading');
  expect(element.textContent).toContain('正在读取待办');
  expect(element.querySelector('[data-agent-todos-status]')?.classList.contains('sr-only')).toBe(false);
  expect(harness.beginContentRead).toHaveBeenCalledExactlyOnceWith('main', { kind: 'todo', id: 'todo' }, ['items']);
  expect(harness.loadTranscriptEntities).not.toHaveBeenCalled();
  const items = Array.from({ length: 14 }, (_, index) => todo(`Main task ${index + 1}`, index === 0 ? 'in_progress' : 'pending'));
  await act(async () => {
    harness.agents['main'] = viewState({ todos: items, contentRefs: [], hasMoreHistory: true });
    harness.emit();
  });
  expect(todosStatus()).toBeUndefined();
  expect(element.querySelectorAll('[data-agent-todo-section] li')).toHaveLength(14);
  expect(element.textContent).toContain('Main task 14');
  expect(harness.beginContentRead).toHaveBeenCalledTimes(1);
  await act(async () => {
    harness.agents['main'] = viewState({ todos: [todo('Updated task', 'done')], contentRefs: [] });
    harness.emit();
  });
  expect(element.textContent).toContain('Updated task');
  expect(element.textContent).not.toContain('Main task 14');
  expect(element.textContent).toContain('1/1');
  await render('child', { part: 'work' });
  expect(harness.releaseTodoRead).toHaveBeenCalledTimes(1);
  expect(harness.beginContentRead).toHaveBeenLastCalledWith('child', { kind: 'todo', id: 'todo' }, ['items']);
  expect(element.textContent).not.toContain('Updated task');
  await render('main', { part: 'work', visible: false });
  expect(harness.releaseTodoRead).toHaveBeenCalledTimes(2);
  expect(harness.beginContentRead).toHaveBeenCalledTimes(2);
});

it('keeps an unread todo distinct from empty on a failed item read and offers retry', async () => {
  harness.agents['main'] = viewState({ todos: [], contentRefs: [todoItemsRef],
    detailLoads: { [`content:${JSON.stringify(todoItemsRef)}`]: { status: 'error', message: 'Read failed' } } });
  await render('main', { part: 'work' });
  expect(todosStatus()).toBe('error');
  expect(element.textContent).toContain('待办读取失败');
  expect(element.textContent).not.toContain('暂无待办');
  const retry = element.querySelector<HTMLElement>('[data-agent-todos-status] button');
  expect(retry?.textContent).toBe('重试');
  await act(async () => retry?.click());
  expect(harness.retryTodoRead).toHaveBeenCalledTimes(1);
});

it('reads omitted todo entities only, while a complete empty todo stays hidden', async () => {
  harness.agents['main'] = viewState({ todos: [], globalCoverage: {
    version: 1, tasks: { returned: 0, total: 0, hasMore: false },
    attachments: { returned: 0, total: 0, hasMore: false }, prompts: { returned: 0, total: 0, hasMore: false },
    todos: { returned: 0, total: 1, hasMore: true },
  } });
  await render('main', { part: 'work' });
  expect(todosStatus()).toBe('loading');
  expect(harness.loadTranscriptEntities).toHaveBeenCalledExactlyOnceWith('main', 'todo');
  await act(async () => {
    harness.agents['main'] = viewState({ todos: [] });
    harness.emit();
  });
  expect(todosStatus()).toBeUndefined();
  expect(element.querySelector('[data-agent-todo-section]')).toBeNull();
  expect(element.textContent).not.toContain('正在读取待办');
});

it('continues todo refs from a delayed baseline and live updates through the canonical controller without history reads', async () => {
  const page = vi.fn();
  const firstItems = Array.from({ length: 14 }, (_, index) => todo(`Task ${index + 1}`, index === 0 ? 'in_progress' : 'pending'));
  const content = vi.fn(async ({ ref }: { ref: ContentRef }) => ({ ref,
    value: ref.revision === 'updated' ? [todo('Live updated task', 'done')] : firstItems, contentRefs: [] }));
  const view = {
    snapshot: async () => ({ as_of_seq: 1, epoch: 'e', session: { id: 'session', workspace_id: 'workspace_example',
      metadata: { cwd: 'C:/example' }, agent_config: {}, usage: { turn_count: 0 } }, in_flight_turn: null }),
    transcript: { page, content },
    subscribe: () => ({ close() {}, updateTranscriptCursor() {}, updateSessionCursor() {}, setTranscriptGrades() {} }),
  } as unknown as SessionViewFacade;
  const controller = new SessionController({} as SessionTransport, view, 'session', {
    scheduler: { schedule: (fn) => { fn(); return 0; }, cancel() {} },
  });
  await controller.open();
  harness.holder.value = { subscribe: harness.registry.subscribe, snapshot: harness.registry.snapshot,
    [Symbol.iterator]: () => [controller][Symbol.iterator]() };
  try {
    await render('main', { part: 'work' });
    expect(content).not.toHaveBeenCalled();
    const snapshot: AgentTranscriptSnapshot = { items: [], tasks: [], interactions: [], attachments: [], prompts: [], meta: {},
      todos: [{ todoId: 'todo', items: [], contentRefs: [todoItemsRef] }], hasMoreOlder: true };
    await act(async () => { controller.handleTranscript({ type: 'transcript.reset', session_id: 'session', agent_id: 'main', snapshot,
      grade: 'delta', coverage: { kind: 'tail', hasMoreOlder: true }, cursor: { seq: 1, epoch: 'e' } }); });
    await act(async () => { await vi.waitFor(() => { expect(controller.getState().todos).toHaveLength(14); }); });
    expect(element.querySelectorAll('[data-agent-todo-section] li')).toHaveLength(14);
    const updatedRef = { ...todoItemsRef, total: 1, revision: 'updated' };
    const ops: TranscriptOperation[] = [{ op: 'todo.upsert', todo: { todoId: 'todo', items: [], contentRefs: [updatedRef] } }];
    await act(async () => { controller.handleTranscript({ type: 'transcript.ops', session_id: 'session', agent_id: 'main', ops,
      cursor: { seq: 2, epoch: 'e' }, through_seq: 2 }); });
    await act(async () => { await vi.waitFor(() => { expect(controller.getState().todos[0]?.title).toBe('Live updated task'); }); });
    expect(element.textContent).toContain('Live updated task');
    expect(element.textContent).not.toContain('Task 14');
    expect(element.textContent).toContain('1/1');
    expect(content).toHaveBeenCalledTimes(2);
    for (const [input] of content.mock.calls) expect(input).toMatchObject({ agentId: 'main', ref: { source: { kind: 'todo', id: 'todo' }, path: ['items'] } });
    expect(page).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.render(null); });
    controller.close();
  }
});

it('restores bounded notes on first open and keeps the latest revision through a delayed old reply without history or scroll resets', async () => {
  const fields = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'];
  const makeTodo = (rev: number): TranscriptTodo => ({ todoId: 'todo', items: [],
    notes: Object.fromEntries(fields.map((field) => [field, Array.from({ length: ['goal', 'directives', 'evidence', 'files'].includes(field) ? 18 : 4 }, (_, index) => `Revision ${rev} ${field} line ${index}: complete evidence and next action.`).join('\n')])),
    notesMeta: { ...notesMeta, rev },
  });
  let canonical = makeTodo(4);
  const page = vi.fn();
  let delayed: (() => void) | undefined;
  let delayNext = false;
  const content = vi.fn(({ ref }: { agentId: string; ref: ContentRef }): Promise<ContentSegment> => {
    const segment = readContentSegment(canonical, ref);
    if (!delayNext) return Promise.resolve(segment);
    delayNext = false;
    return new Promise((resolve) => { delayed = () => { resolve(segment); }; });
  });
  const view = {
    snapshot: async () => ({ as_of_seq: 1, epoch: 'e', session: { id: 'session', workspace_id: 'workspace_example',
      metadata: { cwd: 'C:/example' }, agent_config: {}, usage: { turn_count: 0 } }, in_flight_turn: null }),
    transcript: { page, content },
    subscribe: () => ({ close() {}, updateTranscriptCursor() {}, updateSessionCursor() {}, setTranscriptGrades() {} }),
  } as unknown as SessionViewFacade;
  const controller = new SessionController({} as SessionTransport, view, 'session', {
    scheduler: { schedule: (fn) => { fn(); return 0; }, cancel() {} },
  });
  await controller.open();
  harness.holder.value = { subscribe: harness.registry.subscribe, snapshot: harness.registry.snapshot,
    [Symbol.iterator]: () => [controller][Symbol.iterator]() };
  const snapshot: AgentTranscriptSnapshot = { items: [], tasks: [], interactions: [], attachments: [], prompts: [], meta: {},
    todos: [boundedEntity(canonical, { kind: 'todo', id: 'todo' }, 2048)] };
  expect(snapshot.todos[0]?.notes?.evidence?.length).toBeLessThan(canonical.notes!.evidence!.length);
  const serverStore = new AgentTranscript('main');
  const publish = (rev: number, seq: number) => {
    canonical = makeTodo(rev);
    const ops: TranscriptOperation[] = rev === 5
      ? [{ op: 'todo.upsert', todo: boundedEntity(canonical, { kind: 'todo', id: 'todo' }, 2048) }]
      : boundedTranscriptOps([{ op: 'todo.upsert', todo: canonical }], serverStore);
    controller.handleTranscript({ type: 'transcript.ops', session_id: 'session', agent_id: 'main', ops, cursor: { seq, epoch: 'e' }, through_seq: seq });
  };
  try {
    controller.handleTranscript({ type: 'transcript.reset', session_id: 'session', agent_id: 'main', snapshot,
      grade: 'delta', coverage: { kind: 'tail', hasMoreOlder: true }, cursor: { seq: 1, epoch: 'e' } });
    await render('main', { part: 'work' });
    expect(content).not.toHaveBeenCalled();
    const toggle = element.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!;
    await act(async () => { toggle.click(); });
    await act(async () => { await vi.waitFor(() => { expect(controller.getState().todoNotes).toEqual(canonical.notes); }); });
    for (const field of fields) expect(element.querySelector(`[data-agent-notes-part="${field}"] dd`)?.textContent).toBe(canonical.notes![field]);
    expect(element.querySelector('[data-agent-notes-meta]')?.textContent).toContain('第 4 版');
    const list = element.querySelector<HTMLElement>('[data-agent-notes-section] dl')!;
    list.scrollTop = 77;
    delayNext = true;
    await act(async () => { publish(5, 2); });
    await vi.waitFor(() => { expect(delayed).toBeDefined(); });
    await act(async () => { publish(6, 3); delayed!(); });
    await act(async () => { await vi.waitFor(() => { expect(controller.getState().todoNotes).toEqual(canonical.notes); }); });
    expect(controller.getState().todoNotesMeta?.rev).toBe(6);
    expect(element.querySelector('[data-agent-notes-meta]')?.textContent).toContain('第 6 版');
    expect(element.textContent).not.toContain('Revision 5');
    expect(element.querySelector('[data-agent-notes-section] dl')).toBe(list);
    expect(list.scrollTop).toBe(77);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const reads = content.mock.calls.length;
    await act(async () => { toggle.click(); publish(7, 4); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(content).toHaveBeenCalledTimes(reads);
    for (const [input] of content.mock.calls) expect(input).toMatchObject({ agentId: 'main', ref: { source: { kind: 'todo', id: 'todo' }, path: ['notes', expect.any(String)] } });
    expect(page).not.toHaveBeenCalled();
  } finally {
    delayed?.();
    await act(async () => { root.render(null); });
    controller.close();
  }
});

it('scopes expanded notes reads to the selected agent and releases them on hide or navigation', async () => {
  const ref = { ...todoItemsRef, path: ['notes', 'goal'], kind: 'text' as const, offset: 4, total: 40 };
  harness.agents['main'] = viewState({ todoNotes: { goal: 'Main' }, todoNotesMeta: notesMeta, contentRefs: [ref] });
  harness.agents['child'] = viewState({ todoNotes: { goal: 'Child' }, todoNotesMeta: { ...notesMeta, rev: 1 }, contentRefs: [ref] });
  await render('main', { part: 'work' });
  expect(harness.beginContentRead.mock.calls.map((call) => call)).not.toContainEqual(['main', { kind: 'todo', id: 'todo' }, ['notes', 'notesMeta']]);
  await act(async () => { element.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!.click(); });
  expect(harness.beginContentRead).toHaveBeenLastCalledWith('main', { kind: 'todo', id: 'todo' }, ['notes', 'notesMeta']);
  const released = harness.releaseTodoRead.mock.calls.length;
  await render('child', { part: 'work' });
  expect(harness.releaseTodoRead.mock.calls.length).toBe(released + 2);
  expect(element.querySelector('[data-agent-notes-section] button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  expect(element.textContent).not.toContain('Main');
  await act(async () => { element.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!.click(); });
  expect(harness.beginContentRead).toHaveBeenLastCalledWith('child', { kind: 'todo', id: 'todo' }, ['notes', 'notesMeta']);
  const calls = harness.beginContentRead.mock.calls.length;
  const releasedChild = harness.releaseTodoRead.mock.calls.length;
  await render('child', { part: 'work', visible: false });
  expect(harness.releaseTodoRead.mock.calls.length).toBe(releasedChild + 2);
  expect(harness.beginContentRead).toHaveBeenCalledTimes(calls);
});

it('shows legal complete inline working notes and all 14 todos on first open and hot update without content or history reads', async () => {
  const fields = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'];
  const makeTodo = (rev: number): TranscriptTodo => ({ todoId: 'todo',
    items: Array.from({ length: 14 }, (_, index): TranscriptTodo['items'][number] => ({ title: `Revision ${rev} task ${index + 1}`, status: index === 0 ? 'in_progress' : 'pending' })),
    notes: Object.fromEntries(fields.map((field, index) => [field, `Revision ${rev} ${field}: `.padEnd([1500, 1500, 1500, 1500, 499, 499, 499, 3][index]!, '字').slice(0, [1500, 1500, 1500, 1500, 499, 499, 499, 3][index]!)])),
    notesMeta: { ...notesMeta, rev },
  });
  let canonical = makeTodo(4);
  expect(Object.values(canonical.notes!).every((text) => text!.length <= 1500)).toBe(true);
  expect(Object.values(canonical.notes!).reduce((sum, text) => sum + text!.length, 0)).toBeLessThanOrEqual(7500);
  const page = vi.fn();
  const content = vi.fn();
  const view = {
    snapshot: async () => ({ as_of_seq: 1, epoch: 'e', session: { id: 'session', workspace_id: 'workspace_example',
      metadata: { cwd: 'C:/example' }, agent_config: {}, usage: { turn_count: 0 } }, in_flight_turn: null }),
    transcript: { page, content },
    subscribe: () => ({ close() {}, updateTranscriptCursor() {}, updateSessionCursor() {}, setTranscriptGrades() {} }),
  } as unknown as SessionViewFacade;
  const controller = new SessionController({} as SessionTransport, view, 'session', {
    scheduler: { schedule: (fn) => { fn(); return 0; }, cancel() {} },
  });
  await controller.open();
  harness.holder.value = { subscribe: harness.registry.subscribe, snapshot: harness.registry.snapshot,
    [Symbol.iterator]: () => [controller][Symbol.iterator]() };
  const snapshot = boundedTranscriptSnapshot({ items: [], tasks: [], interactions: [], attachments: [], prompts: [], meta: {}, todos: [canonical] }, 'main');
  const serverStore = new AgentTranscript('main');
  try {
    controller.handleTranscript({ type: 'transcript.reset', session_id: 'session', agent_id: 'main', snapshot,
      grade: 'turn', coverage: { kind: 'tail', hasMoreOlder: true }, cursor: { seq: 1, epoch: 'e' } });
    await render('main', { part: 'work' });
    expect(controller.getState().todoNotes).toEqual(canonical.notes);
    expect(element.querySelectorAll('[data-agent-todo-section] li')).toHaveLength(14);
    const toggle = element.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!;
    await act(async () => { toggle.click(); });
    for (const field of fields) expect(element.querySelector(`[data-agent-notes-part="${field}"] dd`)?.textContent).toBe(canonical.notes![field]);
    const list = element.querySelector<HTMLElement>('[data-agent-notes-section] dl')!;
    list.scrollTop = 77;
    canonical = makeTodo(5);
    await act(async () => {
      controller.handleTranscript({ type: 'transcript.ops', session_id: 'session', agent_id: 'main',
        ops: boundedTranscriptOps([{ op: 'todo.upsert', todo: canonical }], serverStore), cursor: { seq: 2, epoch: 'e' }, through_seq: 2 });
    });
    for (const field of fields) expect(element.querySelector(`[data-agent-notes-part="${field}"] dd`)?.textContent).toBe(canonical.notes![field]);
    expect(element.textContent).toContain('Revision 5 task 14');
    expect(element.querySelectorAll('[data-agent-todo-section] li')).toHaveLength(14);
    expect(element.querySelector('[data-agent-notes-meta]')?.textContent).toContain('第 5 版');
    expect(element.querySelector('[data-agent-notes-section] dl')).toBe(list);
    expect(list.scrollTop).toBe(77);
    expect(content).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.render(null); });
    controller.close();
  }
});
