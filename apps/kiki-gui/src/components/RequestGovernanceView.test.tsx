// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { CONCURRENCY_RULES_SETTINGS_HREF, RequestGovernanceBadge, RequestGovernanceView } from './RequestGovernanceView';
import { clearToasts, getToasts } from '../lib/toasts';
import type { RequestGovernanceSnapshot } from '@kiki/protocol';

const connection = vi.hoisted(() => ({
  scopeId: 'test-domain',
  wsStatus: 'open',
  client: {
    getRequestGovernance: vi.fn(),
    setRequestGovernanceRules: vi.fn(),
    listModels: vi.fn().mockResolvedValue({ items: [] }),
    listProviders: vi.fn().mockResolvedValue({ items: [] }),
    getSession: vi.fn(),
    session: vi.fn(),
    klient: undefined as unknown,
  },
}));
vi.mock('../state/connection', () => ({ useConnection: () => connection, useOptionalConnection: () => connection }));
const mockLiveAgent = vi.fn().mockReturnValue({
  snapshot: {
    domainId: 'this-service',
    asOf: '2026-01-01T12:00:00Z',
    mainActive: 1,
    subActive: 2,
    independentActive: 1,
    totalActive: 4,
    queued: 0,
    dimensions: [
      { dimension: 'executor', id: 'kiki', mainActive: 1, subActive: 1, independentActive: 0, totalActive: 2 },
      { dimension: 'executor', id: 'claude-code', mainActive: 0, subActive: 1, independentActive: 1, totalActive: 2 },
      { dimension: 'profile', id: 'dev', mainActive: 1, subActive: 2, independentActive: 1, totalActive: 4 },
    ],
  },
  stale: false,
  loading: false,
  error: null,
  refresh: vi.fn(),
});
vi.mock('../lib/liveAgentGovernance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/liveAgentGovernance')>();
  return {
    ...actual,
    useLiveAgentGovernance: () => mockLiveAgent(),
  };
});
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) act(dispose); vi.useRealTimers(); vi.clearAllMocks(); });

const RULE: RequestGovernanceSnapshot['rules'][number] = { id: 'provider-cap', resource: 'model_request', scope: 'global', providers: ['provider-example'], maxConcurrent: 3, subagentsOnly: false, overflow: 'queue', enabled: true };
const snapshot: RequestGovernanceSnapshot = {
  domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z',
  active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' },
  dimensions: [{ dimension: 'provider', id: 'provider-example', active: 3, queued: 2 }],
  rules: [{ ...RULE }],
  waiting: [],
};

/** Exposes the router path so a test can see where a session name led. */
function LocationProbe() {
  const location = useLocation();
  return <span hidden data-location={location.pathname} data-full-location={`${location.pathname}${location.search}${location.hash}`} />;
}

function mount(view: 'realtime' | 'limits', withBadge = false, seed?: (queryClient: QueryClient) => void) {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/usage?panel=${view}`]}>
          <I18nProvider>
            {withBadge ? <RequestGovernanceBadge /> : null}
            <RequestGovernanceView view={view} />
            <LocationProbe />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };
  disposals.push(() => { root.unmount(); queryClient.clear(); container.remove(); reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
  return { container, render };
}

/** Lets the 1s poll flush so mocked responses land. */
async function settle(render: () => void, ms = 10) {
  await act(async () => { render(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('live request governance', () => {
  it('shows existing concurrency rules directly inline under the live summary and edits them without leaving /usage', async () => {
    expect(CONCURRENCY_RULES_SETTINGS_HREF).toBe('/settings/ai?tab=defaults#st-card-concurrency');
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue({ ...snapshot, rules: [RULE, { ...RULE, id: 'paused-cap', enabled: false }] });
    connection.client.setRequestGovernanceRules.mockResolvedValue({});
    const { container, render } = mount('realtime');
    await settle(render);
    const live = container.querySelector<HTMLElement>('[data-governance-live]')!;
    const summary = container.querySelector<HTMLElement>('[data-governance-rules-summary]')!;
    expect(live.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(live.querySelector('[data-governance-dimensions]')?.textContent).toContain('provider-example');
    expect(summary.textContent).toContain('Limited by 1 concurrency rule');
    const manage = container.querySelector<HTMLButtonElement>('[data-governance-manage]')!;
    expect(manage.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-governance-rules]')?.textContent).toContain('Concurrency limits');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    expect(container.querySelector('[data-governance-editor]')).not.toBeNull();
    await act(async () => {
      container.querySelector('[data-governance-rule="provider-cap"]')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'provider-cap', enabled: false }),
      expect.objectContaining({ id: 'paused-cap', enabled: false }),
    ]);
    expect(container.querySelector('[data-full-location]')?.getAttribute('data-full-location')).toBe('/usage?panel=realtime');
    await act(async () => { manage.click(); });
    expect(manage.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-governance-rules]')).toBeNull();
  });

  it('keeps the inline editor folded when no rules exist and expands it inline on Manage rules click', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue({ ...snapshot, rules: [] });
    connection.client.setRequestGovernanceRules.mockResolvedValue({});
    const { container, render } = mount('realtime');
    await settle(render);
    const manage = container.querySelector<HTMLButtonElement>('[data-governance-manage]')!;
    expect(manage.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-governance-rules]')).toBeNull();
    await act(async () => { manage.click(); });
    expect(manage.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-governance-empty]')?.textContent).toContain('No limit rules yet');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click(); });
    expect(container.querySelector('[data-governance-editor]')).not.toBeNull();
  });

  it('shows one dimension at a time instead of stacking the cuts into one table', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      dimensions: [
        { dimension: 'model', id: 'kimi-k3', active: 2, queued: 1 },
        { dimension: 'provider', id: 'provider-example', active: 3, queued: 2 },
        { dimension: 'role', id: 'subagent', active: 2, queued: 0 },
      ],
    });
    const { container, render } = mount('realtime');
    await settle(render);
    const panel = () => container.querySelector<HTMLElement>('[data-governance-dimensions]')!;
    expect(container.querySelector('[data-axis="governance-dimension"]')).not.toBeNull();
    // Only the model cut is on screen; provider and role do not ride along.
    expect(panel().getAttribute('data-governance-dimension')).toBe('model');
    expect(panel().textContent).toContain('kimi-k3');
    expect(panel().textContent).not.toContain('provider-example');
    expect(panel().textContent).not.toContain('Subagents');
    // Switching replaces the list rather than adding to it.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-axis-value="provider"]')!.click(); });
    expect(panel().getAttribute('data-governance-dimension')).toBe('provider');
    expect(panel().textContent).toContain('provider-example');
    expect(panel().textContent).not.toContain('kimi-k3');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-axis-value="role"]')!.click(); });
    expect(panel().getAttribute('data-governance-dimension')).toBe('role');
    expect(panel().textContent).toContain('Subagents');
    expect(panel().textContent).not.toContain('kimi-k3');
    // The headline totals are the server's and do not change with the switch.
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-queued]')?.textContent).toBe('2');
  });

  it('offers only the dimensions the snapshot actually carries', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      dimensions: [{ dimension: 'role', id: 'subagent', active: 2, queued: 0 }],
    });
    const { container, render } = mount('realtime');
    await settle(render);
    // One dimension means no switcher to offer, and the idle copy is not shown
    // when that dimension does have rows.
    expect(container.querySelector('[data-axis="governance-dimension"]')).toBeNull();
    const panel = container.querySelector<HTMLElement>('[data-governance-dimensions]')!;
    expect(panel.textContent).toContain('Subagents');
    expect(container.querySelector('[data-governance-dimensions-empty]')).toBeNull();
  });

  it.each(['zh', 'en'] as const)('keeps authoritative counts and one amber stale line on disconnection (%s)', async (locale) => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', locale);
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('realtime', true);
    await settle(render);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-queued]')?.textContent).toBe('2');
    expect(container.querySelector('[data-governance-stale]')).toBeNull();
    expect(container.textContent).not.toContain('unmanaged');
    connection.wsStatus = 'closed';
    connection.client.getRequestGovernance.mockRejectedValue(new Error('offline'));
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-queued]')?.textContent).toBe('2');
    expect(container.querySelector('[data-request-governance-badge]')?.textContent).toBe(locale === 'zh' ? '2 排队 ◦' : '2 queued ◦');
    const staleLines = container.querySelectorAll('[data-governance-stale]');
    expect(staleLines).toHaveLength(1);
    expect(staleLines[0]?.textContent).toContain(locale === 'zh'
      ? '数据可能已过期 · 最后更新 '
      : 'This view may be out of date · last update ');
    expect(staleLines[0]?.classList.contains('text-amber-ink')).toBe(true);
    expect(staleLines[0]?.className).not.toMatch(/(?:^|\s)(?:bg-|border)/);
  });

  it('hides raw session dimension rows from the live breakdown', async () => {
    vi.useFakeTimers();
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      dimensions: [
        { dimension: 'session', id: 'session_3f9e1ab7', active: 2, queued: 0 },
        { dimension: 'role', id: 'subagent', active: 2, queued: 0 },
      ],
    });
    const { container, render } = mount('realtime');
    await settle(render);
    expect(container.textContent).not.toContain('session_3f9e1ab7');
    expect(container.querySelector('[data-governance-dimensions]')?.textContent).toContain('Subagents');
  });

  it('shows RequestGovernanceBadge only while something is queued', async () => {
    vi.useFakeTimers();
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockRejectedValueOnce(new Error('unavailable'));
    const { container, render } = mount('realtime', true);
    await settle(render);
    expect(container.querySelector('[data-request-governance-badge]')).toBeNull();

    connection.client.getRequestGovernance.mockResolvedValueOnce({
      ...snapshot,
      active: 0,
      queued: 0,
      dimensions: [],
    });
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-request-governance-badge]')).toBeNull();

    // Running alone needs nothing from the reader: no badge.
    connection.client.getRequestGovernance.mockResolvedValueOnce({
      ...snapshot,
      active: 2,
      queued: 0,
    });
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-request-governance-badge]')).toBeNull();

    connection.client.getRequestGovernance.mockResolvedValueOnce({
      ...snapshot,
      active: 2,
      queued: 1,
    });
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-request-governance-badge]')?.textContent).toMatch(/^1 (queued|排队)$/);
  });
});

describe('limit rules editor', () => {
  beforeEach(() => {
    connection.wsStatus = 'open';
    connection.client.listModels.mockResolvedValue({ items: [] });
    connection.client.listProviders.mockResolvedValue({ items: [] });
    connection.client.setRequestGovernanceRules.mockResolvedValue({});
  });

  it('guides the empty state into adding a rule and saves it through the config write path', async () => {
    vi.useFakeTimers();
    connection.client.getRequestGovernance.mockResolvedValue({ ...snapshot, rules: [] });
    const { container, render } = mount('limits');
    await settle(render);
    expect(container.querySelector('[data-governance-empty]')?.textContent).toContain('No limit rules yet');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click(); });
    const editor = container.querySelector('[data-governance-editor]')!;
    const name = editor.querySelector<HTMLInputElement>('input[placeholder="e.g. provider-cap"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'provider-cap');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledTimes(1);
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'provider-cap', scope: 'global', maxConcurrent: 2, overflow: 'queue', enabled: true }),
    ]);
  });

  it('rejects an invalid cap locally without touching the server', async () => {
    vi.useFakeTimers();
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    const editor = container.querySelector('[data-governance-editor]')!;
    const cap = editor.querySelector<HTMLInputElement>('input[placeholder="Unlimited"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(cap, '0');
      cap.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    expect(editor.querySelector('[role="alert"]')?.textContent).toContain('whole number above zero');
    expect(connection.client.setRequestGovernanceRules).not.toHaveBeenCalled();
  });

  it('toggles a rule off straight from the row', async () => {
    vi.useFakeTimers();
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);
    const row = container.querySelector('[data-governance-rule="provider-cap"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'provider-cap', enabled: false }),
    ]);
  });

  it('keeps a paused rule paused when its form is saved', async () => {
    vi.useFakeTimers();
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      rules: [{ ...RULE, enabled: false }],
    });
    const { container, render } = mount('limits');
    await settle(render);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    const editor = container.querySelector('[data-governance-editor]')!;
    const cap = editor.querySelector<HTMLInputElement>('input[placeholder="Unlimited"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(cap, '4');
      cap.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'provider-cap', maxConcurrent: 4, enabled: false }),
    ]);
  });

  it('deletes a rule at once and writes the previous list back on undo', async () => {
    vi.useFakeTimers();
    clearToasts();
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-editor-delete]')!.click(); });
    await settle(render);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([]);
    const toast = getToasts().at(-1)!;
    expect(toast.text).toContain('provider-cap');
    await act(async () => { await toast.undo!.run(); });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenLastCalledWith(snapshot.rules);
  });

  it('shows both request view and live agent view vertically with single-dimension breakdown', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('realtime');
    await settle(render);

    // Both live sections sit on the page at once, always shown.
    const requestPanel = container.querySelector<HTMLElement>('[data-governance-live]')!;
    const agentPanel = container.querySelector<HTMLElement>('[data-governance-live-agents]')!;
    expect(requestPanel).not.toBeNull();
    expect(requestPanel.querySelector('[data-governance-dimensions]')).not.toBeNull();
    expect(agentPanel).not.toBeNull();

    // Headline counts for agents: main, sub, independent, total
    expect(container.querySelector('[data-governance-main-agents]')?.textContent).toBe('1');
    expect(container.querySelector('[data-governance-sub-agents]')?.textContent).toBe('2');
    expect(container.querySelector('[data-governance-independent-agents]')?.textContent).toBe('1');
    expect(container.querySelector('[data-governance-total-agents]')?.textContent).toBe('4');

    // Single dimension breakdown (default: executor)
    const dimTable = container.querySelector('[data-governance-agent-dimensions]')!;
    expect(dimTable.getAttribute('data-governance-agent-dimension')).toBe('executor');
    // Executor display: builtin kiki mapped to Kiki (Built-in), external harness displayed truthfully
    expect(dimTable.textContent).toContain('Kiki (Built-in)');
    expect(dimTable.textContent).toContain('claude-code');

    // Switch to profile dimension
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis-value="profile"]')!.click();
    });
    expect(dimTable.getAttribute('data-governance-agent-dimension')).toBe('profile');
    expect(dimTable.textContent).toContain('dev');
    expect(dimTable.textContent).not.toContain('claude-code');
  });

  it('supports adding and saving a live agent concurrency limit rule', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click();
    });

    const editor = container.querySelector('[data-governance-editor]')!;
    expect(editor).not.toBeNull();

    // Switch resource to agent_execution
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-axis-value="agent_execution"]')!.click();
    });

    // Check executor, profile, and role-scope inputs are present
    const execInput = editor.querySelector<HTMLInputElement>('[data-governance-executors-input]')!;
    const profInput = editor.querySelector<HTMLInputElement>('[data-governance-profiles-input]')!;
    expect(execInput).not.toBeNull();
    expect(profInput).not.toBeNull();

    // Fill in executor and profile
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(execInput, 'kiki, acp');
      execInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(profInput, 'dev');
      profInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Select main_only role scope
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-axis-value="main_only"]')!.click();
    });

    // Submit form
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      RULE,
      expect.objectContaining({
        resource: 'agent_execution',
        executors: ['kiki', 'acp'],
        profiles: ['dev'],
        roles: ['main'],
        maxConcurrent: 2,
        overflow: 'queue',
        enabled: true,
      }),
    ]);
    const saved = connection.client.setRequestGovernanceRules.mock.calls[0]?.[0]?.[1];
    expect(saved).not.toHaveProperty('role_scope');
  });

  it('omits roles when an agent execution rule applies to every role', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click();
    });
    const editor = container.querySelector('[data-governance-editor]')!;
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-axis-value="agent_execution"]')!.click();
    });
    const execInput = editor.querySelector<HTMLInputElement>('[data-governance-executors-input]')!;
    const profInput = editor.querySelector<HTMLInputElement>('[data-governance-profiles-input]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(execInput, 'kiki');
      execInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(profInput, 'dev');
      profInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(editor.querySelector('[data-governance-role-preset]')?.getAttribute('data-governance-role-preset')).toBe('all');
    expect(editor.querySelector('[data-axis-value="all"]')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    const saved = connection.client.setRequestGovernanceRules.mock.calls[0]?.[0]?.[1];
    expect(saved).toEqual(expect.objectContaining({
      resource: 'agent_execution',
      executors: ['kiki'],
      profiles: ['dev'],
    }));
    expect(saved).not.toHaveProperty('roles');
    expect(saved).not.toHaveProperty('role_scope');
    expect(connection.client.setRequestGovernanceRules.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
      id: 'provider-cap',
      resource: 'model_request',
    }));
  });

  it('displays ancestor limit explanation when save fails with request.agent_ancestor_limit', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    connection.client.setRequestGovernanceRules.mockRejectedValueOnce(
      new Error('request.agent_ancestor_limit: parent agent execution slot occupied')
    );
    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click();
    });

    const editor = container.querySelector('[data-governance-editor]')!;
    // Submit form
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    expect(editor.textContent).toContain('Parent agent is occupying the execution slot');
  });

  it('supports multi-select roles when configuring agent_execution rule', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-add]')!.click();
    });

    const editor = container.querySelector('[data-governance-editor]')!;
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-axis-value="agent_execution"]')!.click();
    });

    const execInput = editor.querySelector<HTMLInputElement>('[data-governance-executors-input]')!;
    const profInput = editor.querySelector<HTMLInputElement>('[data-governance-profiles-input]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(execInput, 'kiki, acp');
      execInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(profInput, 'dev');
      profInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Check both main and subagent checkboxes
    const mainBox = editor.querySelector<HTMLInputElement>('[data-governance-role-checkbox="main"]')!;
    const subBox = editor.querySelector<HTMLInputElement>('[data-governance-role-checkbox="subagent"]')!;
    expect(mainBox).not.toBeNull();
    expect(subBox).not.toBeNull();

    await act(async () => {
      mainBox.click();
      subBox.click();
    });

    expect(editor.querySelector('[data-governance-role-preset]')?.getAttribute('data-governance-role-preset')).toBe('custom');
    expect(editor.querySelector('[data-axis-value="all"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(editor.querySelector('[data-governance-role-selection]')?.textContent).toBe('Main agent, Subagents');
    expect(mainBox.checked).toBe(true);
    expect(subBox.checked).toBe(true);
    expect(editor.querySelector<HTMLInputElement>('[data-governance-role-checkbox="independent"]')?.checked).toBe(false);

    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      RULE,
      expect.objectContaining({
        resource: 'agent_execution',
        executors: ['kiki', 'acp'],
        profiles: ['dev'],
        roles: expect.arrayContaining(['main', 'subagent']),
        enabled: true,
      }),
    ]);
    const saved = connection.client.setRequestGovernanceRules.mock.calls[0]?.[0]?.[1];
    expect(saved.roles).toEqual(['main', 'subagent']);
    expect(saved).not.toHaveProperty('role_scope');
  });

  it('reopens a two-role agent rule on the saved roles without dropping executor, profile, or resource', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    const agentRule = {
      id: 'agent-cap',
      resource: 'agent_execution' as const,
      scope: 'global' as const,
      executors: ['kiki', 'acp'],
      profiles: ['dev'],
      roles: ['main', 'subagent'] as const,
      subagentsOnly: false,
      maxConcurrent: 2,
      overflow: 'queue' as const,
      enabled: true,
    };
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      rules: [RULE, agentRule],
    });
    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-rule="agent-cap"] button')!.click();
    });
    const editor = container.querySelector('[data-governance-editor]')!;
    expect(editor.querySelector<HTMLInputElement>('[data-governance-executors-input]')?.value).toBe('kiki, acp');
    expect(editor.querySelector<HTMLInputElement>('[data-governance-profiles-input]')?.value).toBe('dev');
    expect(editor.querySelector('[data-axis-value="agent_execution"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(editor.querySelector('[data-governance-role-preset]')?.getAttribute('data-governance-role-preset')).toBe('custom');
    expect(editor.querySelector('[data-axis-value="all"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(editor.querySelector('[data-governance-role-selection]')?.textContent).toBe('Main agent, Subagents');

    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    const savedRules = connection.client.setRequestGovernanceRules.mock.calls[0]?.[0];
    expect(savedRules[0]).toEqual(expect.objectContaining({ id: 'provider-cap', resource: 'model_request' }));
    expect(savedRules[1]).toEqual(expect.objectContaining({
      resource: 'agent_execution',
      executors: ['kiki', 'acp'],
      profiles: ['dev'],
      roles: ['main', 'subagent'],
    }));
    expect(savedRules[1]).not.toHaveProperty('role_scope');
  });

  it('displays unknown model as determined by executor without ambient default', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    mockLiveAgent.mockReturnValue({
      snapshot: {
        domainId: 'this-service',
        asOf: '2026-01-01T12:00:00Z',
        mainActive: 0,
        subActive: 1,
        independentActive: 0,
        totalActive: 1,
        queued: 0,
        dimensions: [
          { dimension: 'model', id: 'unknown', mainActive: 0, subActive: 1, independentActive: 0, totalActive: 1 },
        ],
      },
      stale: false,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { container, render } = mount('realtime');
    await settle(render);

    const dimTable = container.querySelector('[data-governance-agent-dimensions]')!;
    expect(dimTable).not.toBeNull();
    expect(dimTable.textContent).toContain('Unknown / determined by executor');
    expect(dimTable.textContent).not.toContain('gemini');
    expect(dimTable.textContent).not.toContain('gpt');
  });

  it('filters rules by resource in limits panel and preserves other resource rules', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    const agentRule = {
      id: 'agent-cap',
      resource: 'agent_execution' as const,
      scope: 'global' as const,
      executors: ['kiki'],
      maxConcurrent: 2,
      overflow: 'queue' as const,
      enabled: true,
    };
    // The resource filter is a list tool: it appears only once the list is
    // long (8 rules) and holds both kinds.
    const moreModelRules = Array.from({ length: 6 }, (_, index) => ({ ...RULE, id: `model-cap-${index}` }));
    connection.client.getRequestGovernance.mockResolvedValueOnce({ ...snapshot, rules: [RULE, agentRule] });
    const short = mount('limits');
    await settle(short.render);
    expect(short.container.querySelector('[data-axis-select]')).toBeNull();
    expect(short.container.querySelectorAll('[data-governance-rule]')).toHaveLength(2);

    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      rules: [RULE, agentRule, ...moreModelRules],
    });

    const { container, render } = mount('limits');
    await settle(render);

    // Initial shows all 8 rules
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(8);

    // Filter by agent_execution: the resource choice lives in the quiet
    // select above the list (the wrapper carries the current value).
    const pick = async (optionValue: string) => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-axis-select] button')!.click();
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>(`[role="option"][data-option-value="${optionValue}"]`)!.click();
      });
    };
    await pick('agent_execution');
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(1);
    expect(container.querySelector('[data-governance-rule="agent-cap"]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rule="provider-cap"]')).toBeNull();
    expect(container.querySelector('[data-axis-select]')?.getAttribute('data-axis-select')).toBe('agent_execution');

    // Filter by model_request
    await pick('model_request');
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(7);
    expect(container.querySelector('[data-governance-rule="provider-cap"]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rule="agent-cap"]')).toBeNull();
  });

  it('picks multiple models from the model picker and preserves missing catalog ids', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.client.listModels.mockResolvedValue({
      items: [
        { id: 'fixture/pro', provider_id: 'fixture', remote_id: 'pro', display_name: 'Fixture Pro', max_context_size: 200000 },
        { id: 'fixture/lite', provider_id: 'fixture', remote_id: 'lite', display_name: 'Fixture Lite', max_context_size: 128000 },
      ],
    });
    const ruleWithMissing = {
      ...RULE,
      id: 'model-cap',
      models: ['legacy/missing-model'],
      providers: undefined,
    };
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      rules: [ruleWithMissing],
    });

    const { container, render } = mount('limits');
    await settle(render);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-governance-rule="model-cap"] button')!.click();
    });
    const editor = container.querySelector('[data-governance-editor]')!;
    const trigger = editor.querySelector<HTMLButtonElement>('#governance-models-model-cap')!;
    expect(trigger.textContent).toContain('legacy/missing-model');
    expect(trigger.querySelector('[data-alias-missing]')?.textContent).toContain('not in catalog');

    await act(async () => { trigger.click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
    const missingRow = panel.querySelector<HTMLButtonElement>('[role="option"][data-option-value="legacy/missing-model"]')!;
    expect(missingRow.getAttribute('aria-selected')).toBe('true');
    expect(missingRow.textContent).toContain('not in catalog');

    // Toggle Fixture Pro and Fixture Lite on without closing the panel
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/pro"]')!.click();
    });
    expect(document.querySelector('[data-select-panel]')).not.toBeNull();
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/lite"]')!.click();
    });
    expect(trigger.textContent).toContain('legacy/missing-model +2');

    // Close picker and save
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });

    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'model-cap',
        models: ['legacy/missing-model', 'fixture/pro', 'fixture/lite'],
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Execution pause/resume — the Live tab's session execution controls
// ---------------------------------------------------------------------------

type ExecutionPhase = 'running' | 'pausing' | 'paused' | 'resuming' | 'failed';

function executionState(phase: ExecutionPhase, overrides: Record<string, unknown> = {}) {
  return {
    phase,
    agents: phase === 'running' ? [] : [{ agentId: 'main', state: phase === 'paused' ? 'paused' : 'settling', resumable: phase === 'paused', turnId: 3 }],
    pauseOperationId: phase === 'running' ? undefined : 'pause-op-1',
    ...overrides,
  };
}

/** Registers one session id with a controllable execution facade + no events. */
function stubExecution(sessionId: string, initial: ReturnType<typeof executionState>) {
  const state = { current: initial };
  const facade = {
    read: vi.fn(async () => state.current),
    pause: vi.fn(async ({ operationId }: { operationId: string }) => {
      state.current = executionState('paused', { pauseOperationId: operationId });
      return state.current;
    }),
    cancelPause: vi.fn(async ({ operationId: _operationId, pauseOperationId }: { operationId: string; pauseOperationId: string }) => {
      state.current = executionState('running', { pauseOperationId });
      return state.current;
    }),
    resume: vi.fn(async () => {
      state.current = executionState('running');
      return state.current;
    }),
  };
  const existing = connection.client.session.getMockImplementation();
  connection.client.session.mockImplementation((id: string) => {
    if (id === sessionId) return { execution: facade, events: { observe: vi.fn(() => { throw new Error('unknown event'); }) } };
    return existing?.(id) ?? { execution: undefined, events: undefined };
  });
  return { state, facade };
}

function liveAgentsWith(sessionIds: readonly string[]) {
  mockLiveAgent.mockReturnValue({
    snapshot: {
      domainId: 'this-service',
      asOf: '2026-01-01T12:00:00Z',
      mainActive: sessionIds.length,
      subActive: 0,
      independentActive: 0,
      totalActive: sessionIds.length,
      queued: 0,
      dimensions: [{ dimension: 'executor', id: 'kiki', mainActive: sessionIds.length, subActive: 0, independentActive: 0, totalActive: sessionIds.length }],
      agents: sessionIds.map((sessionId) => ({ sessionId, agentId: 'main', role: 'main', phase: 'running', startedAt: '2026-01-01T11:00:00Z', executorId: 'native', profileId: 'general', modelId: 'k' })),
    },
    stale: false,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
}

describe('execution pause/resume', () => {
  beforeEach(() => {
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    connection.client.session.mockReturnValue({ execution: undefined, events: undefined });
    connection.client.getSession.mockRejectedValue(new Error('not found'));
  });

  it('pauses a running session from its own row action and shows the paused overview with an explicit resume', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    const { container, render } = mount('realtime');
    await settle(render);

    // Running: the session row offers pause; nothing claims restart safety yet.
    const control = () => container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')!;
    expect(control().textContent).toContain('Pause execution');
    expect(container.querySelector('[data-execution-paused]')).toBeNull();

    await act(async () => { control().querySelector<HTMLButtonElement>('button')!.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Pause this session?');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    expect(execution.facade.pause).toHaveBeenCalledTimes(1);
    expect(execution.facade.pause.mock.calls[0]?.[0]?.operationId).toMatch(/^pause:session-alpha:/);

    // Paused: the overview keeps the manual resume action available.
    await settle(render, 1100);
    const panel = container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('Background tasks may still be running');

    // Explicit resume returns the session to running and clears the overview.
    await act(async () => { panel.querySelector<HTMLButtonElement>('[data-execution-action="resume"]')!.click(); });
    await settle(render);
    expect(execution.facade.resume).toHaveBeenCalledTimes(1);
    const pauseArgs = execution.facade.pause.mock.calls[0] as unknown as [{ operationId: string }];
    const resumeArgs = execution.facade.resume.mock.calls[0] as unknown as [{ pauseOperationId: string }];
    expect(resumeArgs[0].pauseOperationId).toBe(pauseArgs[0].operationId);
    await settle(render, 1100);
    expect(container.querySelector('[data-execution-paused]')).toBeNull();
  });

  it('names sessions from the cached lists, folds several behind one disclosure, and opens a session by name', async () => {
    vi.useFakeTimers();
    const TITLED = 'session_3f9e1ab7-0c2d-4e5f-8a9b-1c2d3e4f5a6b';
    const UNTITLED = 'session_8c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f';
    const UNKNOWN = 'session_d4c3b2a1-9f8e-4d7c-b6a5-0f1e2d3c4b5a';
    const longTitle = 'Refactor the usage aggregation into pure functions and keep the export path byte-stable';
    liveAgentsWith([TITLED, UNTITLED, UNKNOWN]);
    const titled = stubExecution(TITLED, executionState('running'));
    stubExecution(UNTITLED, executionState('running'));
    stubExecution(UNKNOWN, executionState('running'));
    connection.client.getSession.mockRejectedValue(new Error('not found'));
    const { container, render } = mount('realtime', false, (queryClient) => {
      queryClient.setQueryData(['sessions', false, undefined], {
        pages: [{ items: [
          { id: TITLED, title: longTitle, workspace_id: 'wd_example', updated_at: '2026-01-01T12:00:00Z' },
          { id: UNTITLED, title: '', workspace_id: 'wd_example', updated_at: '2026-01-01T12:00:00Z' },
        ], has_more: false }],
        pageParams: [undefined],
      });
    });
    await settle(render, 1100);

    // Folded by default: one disclosure line, no row and no bare id in view.
    const list = container.querySelector<HTMLElement>('[data-execution-sessions]')!;
    const toggle = list.querySelector<HTMLButtonElement>('[data-execution-sessions-toggle]')!;
    expect(list.getAttribute('data-collapsed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Sessions · 3');
    const rows = () => [...list.querySelectorAll<HTMLElement>('[data-execution-session]')];
    expect(rows().every((row) => row.hidden)).toBe(true);
    for (const id of [TITLED, UNTITLED, UNKNOWN]) expect(container.textContent).not.toContain(id);

    // Names: the cached title, the untitled fallback, the unknown fallback —
    // the last two keep a short id; every name keeps the full id on hover.
    const open = (id: string) => container.querySelector<HTMLButtonElement>(`[data-execution-session="${id}"] [data-execution-session-open]`)!;
    expect(open(TITLED).textContent).toContain(longTitle);
    expect(open(TITLED).title).toContain(TITLED);
    expect(open(UNTITLED).textContent).toBe('Untitled session8c1d2e3f');
    expect(open(UNKNOWN).textContent).toBe('Sessiond4c3b2a1');
    // The one metadata read per uncached id is not repeated by later polls.
    await settle(render, 6000);
    expect(connection.client.getSession.mock.calls.filter(([id]) => id === UNKNOWN)).toHaveLength(1);
    expect(connection.client.getSession.mock.calls.filter(([id]) => id === TITLED)).toHaveLength(0);

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rows().some((row) => row.hidden)).toBe(false);

    // A row's pause asks first; cancelling sends nothing.
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-execution-session="${TITLED}"] [data-execution-action="pause"]`)!.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel')!;
    await act(async () => { cancel.click(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(titled.facade.pause).not.toHaveBeenCalled();

    await act(async () => { open(TITLED).click(); });
    expect(container.querySelector<HTMLElement>('[data-location]')?.getAttribute('data-location')).toBe(`/s/${TITLED}`);
  });

  it('keeps paused and failed sessions in view while the list is folded, and pause-all still covers the inventory', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha', 'session-beta', 'session-gamma']);
    const alpha = stubExecution('session-alpha', executionState('running'));
    const beta = stubExecution('session-beta', executionState('paused', { pauseOperationId: 'pause-beta' }));
    stubExecution('session-gamma', executionState('failed', { error: 'resume lost a participant' }));
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-execution-session="${id}"]`)!;
    expect(container.querySelector<HTMLElement>('[data-execution-sessions]')?.getAttribute('data-collapsed')).toBe('true');
    expect(row('session-alpha').hidden).toBe(true);
    expect(row('session-beta').hidden).toBe(false);
    expect(row('session-beta').textContent).toContain('Background tasks may still be running');
    expect(row('session-gamma').hidden).toBe(false);
    expect(row('session-gamma').textContent).toContain('resume lost a participant');

    await act(async () => { row('session-beta').querySelector<HTMLButtonElement>('[data-execution-action="resume"]')!.click(); });
    await settle(render);
    expect(beta.facade.resume).toHaveBeenCalledTimes(1);

    await act(async () => { container.querySelector<HTMLElement>('[data-execution-pause-all] button')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    expect(alpha.facade.pause).toHaveBeenCalledTimes(1);
    // The folded running row surfaces once it is held.
    await settle(render, 1100);
    expect(row('session-alpha').hidden).toBe(false);
    expect(row('session-alpha').textContent).toContain('Paused');
  });

  it('drops the no-op disclosure and states the paused hint once when every session is paused', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha', 'session-beta', 'session-gamma']);
    for (const id of ['session-alpha', 'session-beta', 'session-gamma']) {
      stubExecution(id, executionState('paused', { pauseOperationId: `pause-${id}` }));
    }
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    const list = container.querySelector<HTMLElement>('[data-execution-sessions]')!;
    expect(list.querySelector('[data-execution-sessions-toggle]')).toBeNull();
    expect(list.getAttribute('data-collapsed')).toBeNull();
    expect(list.querySelectorAll('[data-execution-session]:not([hidden])')).toHaveLength(3);
    expect(list.querySelector('[data-execution-shared-hint="paused"]')?.textContent).toContain('Background tasks may still be running');
    expect(list.textContent!.split('Background tasks may still be running')).toHaveLength(2);
    expect(list.querySelectorAll('[data-execution-action="resume"]')).toHaveLength(3);
  });

  it('names the session cut of the agent breakdown instead of showing bare ids', async () => {
    vi.useFakeTimers();
    const TITLED = 'session_3f9e1ab7-0c2d-4e5f-8a9b-1c2d3e4f5a6b';
    const UNKNOWN = 'session_d4c3b2a1-9f8e-4d7c-b6a5-0f1e2d3c4b5a';
    connection.client.getSession.mockRejectedValue(new Error('not found'));
    mockLiveAgent.mockReturnValue({
      snapshot: {
        domainId: 'this-service', asOf: '2026-01-01T12:00:00Z', mainActive: 2, subActive: 0, independentActive: 0, totalActive: 2, queued: 0,
        dimensions: [
          { dimension: 'session', id: TITLED, mainActive: 1, subActive: 0, independentActive: 0, totalActive: 1 },
          { dimension: 'session', id: UNKNOWN, mainActive: 1, subActive: 0, independentActive: 0, totalActive: 1 },
        ],
      },
      stale: false, loading: false, error: null, refresh: vi.fn(),
    });
    const { container, render } = mount('realtime', false, (queryClient) => {
      queryClient.setQueryData(['sessions'], { items: [{ id: TITLED, title: 'Fixture: protocol audit', workspace_id: 'wd_example', updated_at: '2026-01-01T12:00:00Z' }] });
    });
    await settle(render, 1100);
    const table = container.querySelector<HTMLElement>('[data-governance-agent-dimension="session"]')!;
    expect(table.querySelector(`[data-governance-agent-row="${TITLED}"]`)?.textContent).toContain('Fixture: protocol audit');
    expect(table.querySelector(`[data-governance-agent-row="${UNKNOWN}"]`)?.textContent).toContain('Session d4c3b2a1');
    expect(table.textContent).not.toContain(TITLED);
    expect(table.textContent).not.toContain(UNKNOWN);
  });

  it('drops a second pause click while the first request is in flight', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    let finish!: () => void;
    execution.facade.pause.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return executionState('pausing'); });
    const { container, render } = mount('realtime');
    await settle(render);
    const open = () => container.querySelector<HTMLElement>('[data-execution-control="session-alpha"] button')!;
    await act(async () => { open().click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    expect(execution.facade.pause).toHaveBeenCalledTimes(1);
    await act(async () => { open().click(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    finish();
    await settle(render);
    expect(execution.facade.pause).toHaveBeenCalledTimes(1);
  });

  it('offers cancel pause while settling, passes the pause operation, and blocks duplicate clicks', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    execution.facade.pause.mockImplementationOnce(async ({ operationId }: { operationId: string }) => {
      execution.state.current = executionState('pausing', { pauseOperationId: operationId });
      return execution.state.current;
    });
    let finishCancel!: () => void;
    execution.facade.cancelPause.mockImplementationOnce(async ({ pauseOperationId }: { operationId: string; pauseOperationId: string }) => {
      await new Promise<void>((resolve) => { finishCancel = resolve; });
      execution.state.current = executionState('running');
      return execution.state.current;
    });
    const { container, render } = mount('realtime');
    await settle(render);
    const control = () => container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')!;
    await act(async () => { control().querySelector<HTMLButtonElement>('[data-execution-action="pause"]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);

    const cancel = control().querySelector<HTMLButtonElement>('[data-execution-action="cancel-pause"]')!;
    expect(cancel.textContent).toContain('Cancel pause');
    expect(cancel.disabled).toBe(false);
    const pauseArgs = execution.facade.pause.mock.calls[0] as unknown as [{ operationId: string }];
    await act(async () => { cancel.click(); });
    await settle(render);
    expect(execution.facade.cancelPause).toHaveBeenCalledTimes(1);
    expect(control().querySelector<HTMLButtonElement>('[data-execution-action="cancel-pause"]')?.disabled).toBe(true);
    control().querySelector<HTMLButtonElement>('[data-execution-action="cancel-pause"]')?.click();
    expect(execution.facade.cancelPause).toHaveBeenCalledTimes(1);

    finishCancel();
    await settle(render, 1100);
    const cancelArgs = execution.facade.cancelPause.mock.calls[0] as unknown as [{ operationId: string; pauseOperationId: string }];
    expect(cancelArgs[0].operationId).toMatch(/^cancelPause:session-alpha:/);
    expect(cancelArgs[0].pauseOperationId).toBe(pauseArgs[0].operationId);
    expect(execution.state.current.phase).toBe('running');
    expect(control().textContent).toContain('Pause execution');
  });

  it('pauses every session in the full inventory with one action', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha', 'session-beta']);
    const alpha = stubExecution('session-alpha', executionState('running'));
    const beta = stubExecution('session-beta', executionState('running'));
    const { container, render } = mount('realtime');
    await settle(render);
    const pauseAll = container.querySelector<HTMLElement>('[data-execution-pause-all] button')!;
    expect(pauseAll.textContent).toContain('Pause all');
    await act(async () => { pauseAll.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    expect(alpha.facade.pause).toHaveBeenCalledTimes(1);
    expect(beta.facade.pause).toHaveBeenCalledTimes(1);
  });

  it('keeps the original state and shows the server error when pause fails', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    execution.facade.pause.mockRejectedValueOnce(new Error('storage locked'));
    const { container, render } = mount('realtime');
    await settle(render);
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-control="session-alpha"] button')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    // A failed pause keeps the session running: no paused row, no phase chip,
    // and the action is still the pause offer (the error surfaces via toast).
    expect(container.querySelector('[data-execution-paused]')).toBeNull();
    expect(container.querySelector('[data-execution-phase]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')?.textContent).toContain('Pause execution');
  });

  it('shows the failed phase error with a retry-read that re-reads instead of resuming', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('failed', { error: 'resume lost a participant' }));
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    const row = container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"]')!;
    expect(row.textContent).toContain('resume lost a participant');
    expect(row.textContent).toContain('Retry read');
    // A failed row never resumes implicitly: its recovery re-reads the state.
    const readsBefore = execution.facade.read.mock.calls.length;
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-execution-action]')!.click(); });
    await settle(render);
    expect(execution.facade.resume).not.toHaveBeenCalled();
    expect(execution.facade.read.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('offers resume once a failed retry-read returns a durably paused state', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('failed', { error: 'resume lost a participant' }));
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    // The failed retry-read re-reads; the server now reports durably paused,
    // so the row flips to the real resume action.
    execution.state.current = executionState('paused', { pauseOperationId: 'pause-recovered' });
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"] [data-execution-action]')!.click(); });
    await settle(render, 1100);
    const row = container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"]')!;
    expect(row.textContent).toContain('Resume');
    expect(row.textContent).not.toContain('Retry read');
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-execution-action]')!.click(); });
    await settle(render);
    expect(execution.facade.resume).toHaveBeenCalledTimes(1);
    const resumeArgs = execution.facade.resume.mock.calls[0] as unknown as [{ pauseOperationId: string }];
    expect(resumeArgs[0].pauseOperationId).toBe('pause-recovered');
  });

  it('hides the controls on an older server without the execution facade', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    expect(container.querySelector('[data-execution-control]')).toBeNull();
    expect(container.querySelector('[data-execution-pause-all]')).toBeNull();
  });

  // --- review fixes: strict row resume, operation-id lifecycle, discovery pagination, error semantics ---

  it('resumes only its own session when two sessions are paused', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha', 'session-beta']);
    const alpha = stubExecution('session-alpha', executionState('paused', { pauseOperationId: 'pause-alpha' }));
    const beta = stubExecution('session-beta', executionState('paused', { pauseOperationId: 'pause-beta' }));
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    const rowA = container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"]')!;
    const rowB = container.querySelector<HTMLElement>('[data-execution-paused="session-beta"]')!;
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    await act(async () => { rowA.querySelector<HTMLButtonElement>('[data-execution-action]')!.click(); });
    await settle(render);
    // Strictly row A: session-beta's facade was never asked to resume.
    expect(alpha.facade.resume).toHaveBeenCalledTimes(1);
    expect(beta.facade.resume).not.toHaveBeenCalled();
  });

  it('mints a fresh operation id for a second pause after the first settled', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    const { container, render } = mount('realtime');
    await settle(render);
    const open = () => container.querySelector<HTMLElement>('[data-execution-control="session-alpha"] button')!;
    await act(async () => { open().click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    const first = (execution.facade.pause.mock.calls[0] as unknown as [{ operationId: string }])[0].operationId;
    // Resume, then pause again: the second pause must be a NEW operation, not a
    // replay of the settled first receipt.
    await settle(render, 1100);
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"] [data-execution-action]')!.click(); });
    await settle(render, 1100);
    await act(async () => { open().click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    expect(execution.facade.pause).toHaveBeenCalledTimes(2);
    const second = (execution.facade.pause.mock.calls[1] as unknown as [{ operationId: string }])[0].operationId;
    expect(second).not.toBe(first);
  });

  it('discovers a paused session on a strictly older page (100+ sessions)', async () => {
    vi.useFakeTimers();
    liveAgentsWith([]);
    // The real index sorts newest-first; page the keyset strictly OLDER with
    // `before`, and the paused session lives on the second (oldest) page.
    const newest = Array.from({ length: 100 }, (_, index) => ({ id: `session-new-${index}`, executionPhase: 'running' }));
    stubExecution('session-oldest', executionState('paused', { pauseOperationId: 'pause-oldest' }));
    connection.client.klient = {
      global: {
        sessions: {
          list: vi.fn(async (query: { before?: string }) => query.before === undefined
            ? { items: newest, nextCursor: 'session-new-99' }
            : { items: [{ id: 'session-oldest', executionPhase: 'paused' }] }),
        },
      },
    };
    const listMock = (connection.client.klient as { global: { sessions: { list: ReturnType<typeof vi.fn> } } }).global.sessions.list;
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ before: 'session-new-99' }));
    expect(container.querySelector('[data-execution-paused="session-oldest"]')).not.toBeNull();
    (connection.client as { klient: unknown }).klient = undefined;
  });

  it('shows the failing session and its own error on a bulk pause failure, keeping state', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha', 'session-beta']);
    const alpha = stubExecution('session-alpha', executionState('running'));
    const beta = stubExecution('session-beta', executionState('running'));
    beta.facade.pause.mockRejectedValueOnce(new Error('beta storage locked'));
    const { container, render } = mount('realtime');
    await settle(render);
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-pause-all] button')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    // The pause-all row reports the pause verb, the failing session and its
    // error; beta stays running (no phase chip) and can be retried.
    const pauseAll = container.querySelector<HTMLElement>('[data-execution-pause-all]')!;
    expect(pauseAll.textContent).toContain('1 of 2 paused');
    expect(pauseAll.textContent).toContain('beta storage locked');
    expect(container.querySelector('[data-execution-paused="session-beta"]')).toBeNull();
  });

  it('shows the row pause error and keeps the session pausable after a failed pause', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    const execution = stubExecution('session-alpha', executionState('running'));
    execution.facade.pause.mockRejectedValueOnce(new Error('storage locked'));
    const { container, render } = mount('realtime');
    await settle(render);
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-control="session-alpha"] button')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    const control = container.querySelector<HTMLElement>('[data-execution-session="session-alpha"]')!;
    expect(control.textContent).toContain('storage locked');
    expect(control.textContent).toContain('Pause execution');
  });

  it('keeps a paused event over a slower running poll response', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    // A running read that resolves only after the paused event lands. The
    // stale poll must not roll the UI back to running.
    let finishSlowRead!: () => void;
    const slowRunning = new Promise<ReturnType<typeof executionState>>((resolve) => { finishSlowRead = () => resolve(executionState('running')); });
    const facade = {
      read: vi.fn()
        .mockImplementationOnce(() => slowRunning)
        .mockImplementation(async () => executionState('paused', { pauseOperationId: 'pause-evt' })),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    let emitPaused!: (state: ReturnType<typeof executionState>) => void;
    const events = {
      observe: vi.fn((_options: unknown, listener: (state: ReturnType<typeof executionState>) => void) => {
        emitPaused = listener;
        return { dispose: vi.fn() };
      }),
    };
    connection.client.session.mockImplementation((id: string) =>
      id === 'session-alpha' ? { execution: facade, events } : { execution: undefined, events: undefined });
    const { container, render } = mount('realtime');
    await settle(render);
    // The paused event arrives before the slow running read resolves.
    await act(async () => { emitPaused(executionState('paused', { pauseOperationId: 'pause-evt' })); });
    await act(async () => { finishSlowRead(); });
    await settle(render);
    await settle(render, 1100);
    // The event wins: the row reports paused, not the stale running read.
    expect(container.querySelector('[data-execution-paused="session-alpha"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')?.textContent).toContain('Paused');
  });

  it('keeps a newer event state when a read later fails', async () => {
    vi.useFakeTimers();
    liveAgentsWith(['session-alpha']);
    let emitPaused!: (state: ReturnType<typeof executionState>) => void;
    const facade = {
      read: vi.fn()
        .mockImplementationOnce(async () => executionState('running'))
        .mockRejectedValue(new Error('read failed')),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    const events = {
      observe: vi.fn((_options: unknown, listener: (state: ReturnType<typeof executionState>) => void) => {
        emitPaused = listener;
        return { dispose: vi.fn() };
      }),
    };
    connection.client.session.mockImplementation((id: string) =>
      id === 'session-alpha' ? { execution: facade, events } : { execution: undefined, events: undefined });
    const { container, render } = mount('realtime');
    await settle(render);
    await act(async () => { emitPaused(executionState('paused', { pauseOperationId: 'pause-evt' })); });
    await settle(render, 5100); // a later poll whose read fails
    await settle(render);
    // The failed read keeps the event's paused state instead of clearing it.
    expect(container.querySelector('[data-execution-paused="session-alpha"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')?.textContent).toContain('Paused');
  });

  it('shows a visible retry when the cold discovery read fails, and recovers on retry', async () => {
    vi.useFakeTimers();
    liveAgentsWith([]);
    stubExecution('session-late', executionState('paused', { pauseOperationId: 'pause-late' }));
    const list = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('index building'), { code: 50311 }))
      .mockResolvedValue({ items: [{ id: 'session-late', executionPhase: 'paused' }] });
    connection.client.klient = { global: { sessions: { list, get: vi.fn() } }, events: undefined };
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    // A genuine discovery failure (not 40401) surfaces on the recovery line.
    const stale = container.querySelector<HTMLElement>('[data-execution-stale]')!;
    expect(stale).not.toBeNull();
    expect(container.querySelector('[data-execution-paused="session-late"]')).toBeNull();
    await act(async () => { stale.querySelector<HTMLButtonElement>('[data-execution-stale-retry]')!.click(); });
    await settle(render, 1100);
    expect(container.querySelector('[data-execution-paused="session-late"]')).not.toBeNull();
    expect(container.querySelector('[data-execution-stale]')).toBeNull();
    connection.client.klient = undefined;
  });

  it('patches the paused set by session id on an event burst without re-walking history', async () => {
    vi.useFakeTimers();
    liveAgentsWith([]);
    stubExecution('session-burst', executionState('paused', { pauseOperationId: 'pause-burst' }));
    const listeners: Array<(payload: unknown) => void> = [];
    const list = vi.fn(async () => ({ items: [] }));
    const get = vi.fn(async (id: string) => ({ id, executionPhase: 'paused' as const }));
    connection.client.klient = {
      global: { sessions: { list, get } },
      events: {
        on: vi.fn((_event: string, listener: (payload: unknown) => void) => { listeners.push(listener); return { dispose: vi.fn() }; }),
      },
    };
    const { container, render } = mount('realtime');
    await settle(render, 1100);
    expect(container.querySelector('[data-execution-paused="session-burst"]')).toBeNull();
    const historyCalls = list.mock.calls.length;
    // A burst of session events point-patches the set; no full-history re-walk.
    await act(async () => {
      for (let i = 0; i < 8; i++) for (const listener of listeners) listener({ sessionId: 'session-burst' });
    });
    await settle(render, 1100);
    expect(get).toHaveBeenCalledWith('session-burst');
    expect(list.mock.calls.length).toBe(historyCalls);
    expect(container.querySelector('[data-execution-paused="session-burst"]')).not.toBeNull();
    connection.client.klient = undefined;
  });
});

// ---------------------------------------------------------------------------
// Discovery pagination against a faithful keyset index (real semantics, >100)
// ---------------------------------------------------------------------------

import { collectPausedSessionIds } from '../lib/executionControls';

/** Mirrors FileSessionIndex's canonical order + before/after keyset paging. */
function faithfulKeysetIndex(records: readonly { id: string; updatedAt: number; executionPhase?: string }[]) {
  const ordered = [...records].sort((a, b) => (a.updatedAt !== b.updatedAt ? b.updatedAt - a.updatedAt : a.id < b.id ? 1 : -1));
  return {
    list: async (query: { limit?: number; before?: string; after?: string }) => {
      const limit = query.limit ?? ordered.length;
      let window = ordered;
      if (query.before !== undefined) {
        const anchor = ordered.find((r) => r.id === query.before);
        window = anchor === undefined ? [] : ordered.filter((r) => r.updatedAt < anchor.updatedAt || (r.updatedAt === anchor.updatedAt && r.id < anchor.id));
      } else if (query.after !== undefined) {
        const anchor = ordered.find((r) => r.id === query.after);
        window = anchor === undefined ? [] : ordered.filter((r) => r.updatedAt > anchor.updatedAt || (r.updatedAt === anchor.updatedAt && r.id > anchor.id));
      }
      const items = window.slice(0, limit);
      return { items, nextCursor: window.length > limit ? items.at(-1)?.id : undefined };
    },
  };
}

describe('collectPausedSessionIds over a real keyset index', () => {
  it('pages strictly older past 100 records and finds the oldest paused session', async () => {
    const records: { id: string; updatedAt: number; executionPhase?: string }[] = Array.from({ length: 130 }, (_, i) => ({ id: `session-${String(i).padStart(3, '0')}`, updatedAt: 1000 - i, executionPhase: 'running' }));
    records.push({ id: 'session-oldest', updatedAt: 1, executionPhase: 'paused' });
    const index = faithfulKeysetIndex(records);
    const found = await collectPausedSessionIds(index);
    expect(found).toEqual(['session-oldest']);
  });

  it('stops paging when its signal aborts mid-walk', async () => {
    const records = Array.from({ length: 250 }, (_, i) => ({ id: `session-${i}`, updatedAt: 1000 - i, executionPhase: i > 200 ? ('paused' as const) : ('running' as const) }));
    const index = faithfulKeysetIndex(records);
    const controller = new AbortController();
    let calls = 0;
    const counting = { list: async (q: unknown) => { calls += 1; if (calls === 2) controller.abort(); return index.list(q as never); } };
    const found = await collectPausedSessionIds(counting, controller.signal);
    // Aborted after the first page: it never walked the rest of the history.
    expect(calls).toBe(2);
    expect(found).toEqual([]);
  });
});
