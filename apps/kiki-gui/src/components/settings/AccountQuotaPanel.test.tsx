// @vitest-environment jsdom

/**
 * The per-connection quota panel. It used to be a page card listing every
 * signed-in account; it now belongs to the account's own connection row, so
 * these cases check the same facts through the panel's own surface — Kimi
 * Code's per-window limits, the near-limit bar, a zero limit, and the
 * one-line quota other accounts carry.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AccountQuotaPanel } from './AccountQuotaCard';

const getManagedUsage = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getManagedUsage } }),
}));

const method = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, label: id === 'kimi-code' ? 'Kimi Code' : id, provider: `managed:${id}`, protocol: 'openai', signed_in: true,
  account: { state: 'unknown' }, quota: { state: 'unknown' }, ...overrides,
}) as never;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function render(children: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>{children}</I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return container;
}

const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); };

beforeAll(() => { localStorage.setItem('kiki.locale', 'en'); reactAct.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete reactAct.IS_REACT_ACT_ENVIRONMENT; });
beforeEach(() => { getManagedUsage.mockReset(); });
afterEach(() => {
  for (const root of roots.splice(0)) { act(() => { root.unmount(); }); }
  for (const container of containers.splice(0)) container.remove();
});

describe('AccountQuotaPanel', () => {
  it('draws Kimi Code windows, amber at 80%, and never divides by a zero limit', async () => {
    getManagedUsage.mockResolvedValue({
      kind: 'ok',
      summary: { name: 'Weekly', used: 90, limit: 100 },
      limits: [{ name: 'Burst', window: { duration: 5, unit: 'hour' }, used: 10, limit: 100 }, { name: 'Unmetered', used: 3, limit: 0 }],
      extra_usage: null,
    });
    const container = await render(<AccountQuotaPanel method={method('kimi-code')} />);
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
    const rows = [...container.querySelectorAll('[data-quota-row]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute('data-quota-near')).toBe('true');
    expect(rows[1]!.getAttribute('data-quota-near')).toBeNull();
    expect(rows[1]!.textContent).toContain('per 5 h');
    expect(rows[2]!.querySelector('[role="progressbar"]')).toBeNull();
    expect(rows[2]!.textContent).toContain('3 used');
    // It is the vendor's allowance, not this session's token use.
    expect(container.textContent).toContain('not this session’s token use');
  });

  it('shows the vendor message when usage cannot be read, and the status quota for other accounts', async () => {
    getManagedUsage.mockResolvedValue({ kind: 'error', message: 'token expired' });
    const kimi = await render(<AccountQuotaPanel method={method('kimi-code')} />);
    expect(kimi.querySelector('[data-quota-account="kimi-code"] [role="alert"]')?.textContent).toContain('token expired');

    // An account with no per-window usage reads the one line its status carries,
    // and is asked of the usage endpoint not at all.
    getManagedUsage.mockClear();
    const copilot = await render(
      <AccountQuotaPanel method={method('github-copilot', { quota: { state: 'known', label: 'Premium', remaining: 12, unit: 'count' } })} />,
    );
    expect(copilot.querySelector('[data-quota-account="github-copilot"]')?.textContent).toContain('12 left');
    expect(getManagedUsage).not.toHaveBeenCalled();
  });

  it('says an account reports no limits rather than showing a balance it was not given', async () => {
    getManagedUsage.mockResolvedValue({ kind: 'ok', summary: null, limits: [], extra_usage: null });
    const container = await render(<AccountQuotaPanel method={method('kimi-code')} />);
    expect(container.textContent).toContain('The account reports no limits.');
  });

  it('re-reads the vendor allowance on request', async () => {
    getManagedUsage.mockResolvedValue({ kind: 'ok', summary: { name: 'Weekly', used: 1, limit: 100 }, limits: [], extra_usage: null });
    const container = await render(<AccountQuotaPanel method={method('kimi-code')} />);
    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    await click(container.querySelector('button'));
    expect(getManagedUsage).toHaveBeenCalledTimes(2);
  });
});
