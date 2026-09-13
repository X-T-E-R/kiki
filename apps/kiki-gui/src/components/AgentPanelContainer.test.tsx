// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createViewState } from '@kiki/session-core/session';
import { UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { I18nProvider } from '../i18n';
import { AgentPanelContainer } from './AgentPanelContainer';

const { getAgentCapabilities, getAgentPlan } = vi.hoisted(() => ({
  getAgentCapabilities: vi.fn(),
  getAgentPlan: vi.fn(),
}));
vi.mock('../state/connection', () => ({ useConnection: () => ({
  klient: {
    global: { agentPanel: { read: (query: unknown, options: { signal: AbortSignal }) => getAgentCapabilities(query, options.signal) } },
    session: (_sessionId: string) => ({
      agent: (agentId: string) => ({ getPlan: () => getAgentPlan(agentId) }),
    }),
  },
}) }));
let root: Root;
let element: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
  getAgentCapabilities.mockReset();
  getAgentPlan.mockReset();
  getAgentPlan.mockResolvedValue(null);
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
async function render(agentId: string, title: string, busy = false) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><I18nProvider>
    <AgentPanelContainer state={{ ...createViewState('session'), loaded: true, busy, todos: [{ title, status: 'pending' }] }}
      forest={{ byId: {}, roots: [] }} agentId={agentId} />
  </I18nProvider></MemoryRouter></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((done) => setTimeout(done, 0));
  });
}
it('queries the selected identity, keeps missing billing unknown and does not reuse another agent todo', async () => {
  getAgentCapabilities.mockImplementation(async (query) => ({
    context: 'live', owner: { agent_id: query.agent_id }, available: false, targets: [], tools: [], skills: [],
    profile: { name: query.agent_id === 'main' ? 'leader' : 'researcher', source: 'definition:fixture' },
    metrics: { [query.agent_id]: UNKNOWN_AGENT_PANEL_METRICS },
  }));
  await render('main', 'main private todo');
  expect(element.textContent).toContain('main private todo');
  await render('child', 'child todo');
  expect(getAgentCapabilities).toHaveBeenLastCalledWith({ session_id: 'session', agent_id: 'child' }, expect.any(AbortSignal));
  expect(element.textContent).toContain('child todo');
  expect(element.textContent).not.toContain('main private todo');
  expect(element.textContent).toContain('researcher');
  expect(element.textContent).toContain('未知');
  expect(element.textContent).not.toContain('$0');
});
it('refreshes a live active agent, takes a final sample and stops once it settles', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: true, targets: [],
    tools: [], skills: [], metrics: { child: UNKNOWN_AGENT_PANEL_METRICS } });
  vi.useFakeTimers();
  try {
    await render('child', 'active todo', true);
    const initial = getAgentCapabilities.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    expect(getAgentCapabilities.mock.calls.length).toBeGreaterThan(initial);
    await render('child', 'settled todo', false);
    const settled = getAgentCapabilities.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getAgentCapabilities).toHaveBeenCalledTimes(settled);
  } finally {
    vi.useRealTimers();
  }
});
it('does not keep polling a settled historical agent', async () => {
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'child' }, available: false, targets: [] });
  await render('child', 'historical todo');
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

  await render('main', 'main todo');
  const mainPlan = element.querySelector<HTMLElement>('[data-agent-plan]');
  expect(mainPlan).not.toBeNull();
  expect(mainPlan?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(mainPlan?.textContent).not.toContain('Main only');
  await act(async () => { mainPlan?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(element.textContent).toContain('Main only');

  await render('child', 'child todo');
  expect(getAgentPlan).toHaveBeenLastCalledWith('child');
  const childPlan = element.querySelector<HTMLElement>('[data-agent-plan]');
  expect(childPlan?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(element.textContent).not.toContain('Child only');
  await act(async () => { childPlan?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(element.textContent).toContain('Child only');
  expect(element.textContent).not.toContain('Main only');
});

it('shows a recoverable query error instead of silently presenting an empty capability catalog', async () => {
  getAgentCapabilities.mockRejectedValue(new Error('fixture unavailable'));
  await render('child', 'kept local todo');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('fixture unavailable');
  expect(element.textContent).toContain('kept local todo');
});
