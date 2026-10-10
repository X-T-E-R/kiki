// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { RequestGovernanceBadge, RequestGovernanceView } from './RequestGovernanceView';
import type { RequestGovernanceSnapshot } from '@kiki/protocol';

const connection = vi.hoisted(() => ({
  scopeId: 'test-domain',
  wsStatus: 'open',
  client: {
    getRequestGovernance: vi.fn(),
    setRequestGovernanceRules: vi.fn(),
    listModels: vi.fn().mockResolvedValue({ items: [] }),
    listProviders: vi.fn().mockResolvedValue({ items: [] }),
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
    const live = container.querySelector<HTMLDetailsElement>('[data-governance-live]')!;
    const rules = container.querySelector('[data-governance-rules]')!;
    // The detail is what this tab is for, so it starts open.
    expect(live.open).toBe(true);
    expect(live.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(rules.textContent).toContain('Concurrency limits');
    // Still collapsible, and the headline totals stay while it is.
    await act(async () => { live.querySelector('summary')!.click(); });
    expect(live.open).toBe(false);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    await act(async () => { live.querySelector('summary')!.click(); });
    expect(live.open).toBe(true);
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

  it('deletes a rule only after the destructive confirm names it', async () => {
    vi.useFakeTimers();
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('limits');
    await settle(render);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-editor-delete]')!.click(); });
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('provider-cap');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    expect(connection.client.setRequestGovernanceRules).toHaveBeenCalledWith([]);
  });

  it('switches between request view and live agent view with single-dimension breakdown', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const { container, render } = mount('realtime');
    await settle(render);

    // Initial view is requests
    expect(container.querySelector('[data-governance-live]')).not.toBeNull();
    expect(container.querySelector('[data-governance-live-agents]')).toBeNull();

    // Switch to live agents
    const liveModeSwitcher = container.querySelector('[data-axis="governance-live-mode"]')!;
    expect(liveModeSwitcher).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis-value="agents"]')!.click();
    });

    // Requests panel is hidden; live agents panel is displayed and open by default
    expect(container.querySelector('[data-governance-live]')).toBeNull();
    const agentPanel = container.querySelector<HTMLDetailsElement>('[data-governance-live-agents]')!;
    expect(agentPanel).not.toBeNull();
    expect(agentPanel.open).toBe(true);

    // Headline counts: main, sub, independent, total
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
    mockLiveAgent.mockReturnValueOnce({
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

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis-value="agents"]')!.click();
    });

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

    // Filter by agent_execution
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis-value="agent_execution"]')!.click();
    });
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(1);
    expect(container.querySelector('[data-governance-rule="agent-cap"]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rule="provider-cap"]')).toBeNull();

    // Filter by model_request
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-axis-value="model_request"]')!.click();
    });
    expect(container.querySelectorAll('[data-governance-rule]')).toHaveLength(1);
    expect(container.querySelector('[data-governance-rule="provider-cap"]')).not.toBeNull();
    expect(container.querySelector('[data-governance-rule="agent-cap"]')).toBeNull();
  });
});
