// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { RequestGovernanceBadge, RequestGovernanceView } from './RequestGovernanceView';
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
    session: vi.fn(),
    klient: undefined as unknown,
  },
}));
vi.mock('../state/connection', () => ({ useConnection: () => connection }));
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

function mount(view: 'realtime' | 'limits', withBadge = false) {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          {withBadge ? <RequestGovernanceBadge /> : null}
          <RequestGovernanceView view={view} />
        </I18nProvider>
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
  it('shows a compact live summary above editable rules and keeps request details available', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('realtime');
    await settle(render);
    const live = container.querySelector<HTMLElement>('[data-governance-live]')!;
    const rules = container.querySelector('[data-governance-rules]')!;
    // The live detail is a section on the page, not a collapsible card: the
    // request table is what this tab is for, so it is always shown.
    expect(live.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(rules.textContent).toContain('Concurrency limits');
    expect(live.querySelector('[data-governance-dimensions]')?.textContent).toContain('provider-example');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
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
    expect(container.querySelector('[data-request-governance-badge]')?.textContent).toContain('3 · +2');
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

  it('hides RequestGovernanceBadge when unavailable or idle and shows it when active or stale', async () => {
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

    connection.client.getRequestGovernance.mockResolvedValueOnce({
      ...snapshot,
      active: 2,
      queued: 0,
    });
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-request-governance-badge]')?.textContent).toBe('2');
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
    connection.client.getRequestGovernance.mockResolvedValue({
      ...snapshot,
      rules: [RULE, agentRule],
    });

    const { container, render } = mount('limits');
    await settle(render);

    // Initial shows all 2 rules
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(2);

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
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(1);
    expect(container.querySelector('[data-governance-rule="provider-cap"]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rule="agent-cap"]')).toBeNull();
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
    expect(container.querySelector('[data-execution-paused-panel]')).toBeNull();

    await act(async () => { control().querySelector<HTMLButtonElement>('button')!.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Pause this session?');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle(render);
    expect(execution.facade.pause).toHaveBeenCalledTimes(1);
    expect(execution.facade.pause.mock.calls[0]?.[0]?.operationId).toMatch(/^pause:session-alpha:/);

    // Paused: the overview reports restart safety and waits for the user.
    await settle(render, 1100);
    const panel = container.querySelector<HTMLElement>('[data-execution-paused-panel]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-execution-paused="session-alpha"]')?.textContent).toContain('safe to restart');

    // Explicit resume returns the session to running and clears the overview.
    await act(async () => { panel.querySelector<HTMLButtonElement>('button')!.click(); });
    await settle(render);
    expect(execution.facade.resume).toHaveBeenCalledTimes(1);
    const pauseArgs = execution.facade.pause.mock.calls[0] as unknown as [{ operationId: string }];
    const resumeArgs = execution.facade.resume.mock.calls[0] as unknown as [{ pauseOperationId: string }];
    expect(resumeArgs[0].pauseOperationId).toBe(pauseArgs[0].operationId);
    await settle(render, 1100);
    expect(container.querySelector('[data-execution-paused-panel]')).toBeNull();
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
    expect(container.querySelector('[data-execution-paused-panel]')).toBeNull();
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
    await act(async () => { row.querySelector<HTMLButtonElement>('button')!.click(); });
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
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"] button')!.click(); });
    await settle(render, 1100);
    const row = container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"]')!;
    expect(row.textContent).toContain('Resume');
    expect(row.textContent).not.toContain('Retry read');
    await act(async () => { row.querySelector<HTMLButtonElement>('button')!.click(); });
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
    await act(async () => { rowA.querySelector<HTMLButtonElement>('button')!.click(); });
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
    await act(async () => { container.querySelector<HTMLElement>('[data-execution-paused="session-alpha"] button')!.click(); });
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
    const control = container.querySelector<HTMLElement>('[data-execution-control="session-alpha"]')!;
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
});
