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
    expect(live.open).toBe(false);
    expect(live.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(rules.textContent).toContain('Concurrency limits');
    await act(async () => { live.querySelector('summary')!.click(); });
    expect(live.open).toBe(true);
    expect(live.querySelector('[data-governance-dimensions]')?.textContent).toContain('provider-example');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-governance-rule="provider-cap"] button')!.click(); });
    expect(container.querySelector('[data-governance-editor]')).not.toBeNull();
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
});
