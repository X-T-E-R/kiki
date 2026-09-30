// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AccountQuotaCard } from './AccountQuotaCard';
import { CatalogImportCard } from './CatalogImportCard';

const listCatalogProviders = vi.fn();
const importCatalogProvider = vi.fn();
const getManagedUsage = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { listCatalogProviders, importCatalogProvider, getManagedUsage } }),
}));

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), wire_type: 'openai', guessed: false, needs_base_url: false, rejected: false,
  reject_reason: null, env_key: null, models: [{ id: 'm1', max_context_size: 1000, reasoning: false }], ...overrides,
});
const CATALOG = [
  entry('groq'),
  entry('bedrock', { wire_type: null, rejected: true, reject_reason: 'Needs AWS signing.' }),
  entry('fireworks', { wire_type: null, rejected: true, reject_code: 'proprietary-sdk', reject_reason: 'proprietary-sdk' }),
  entry('azure', { needs_base_url: true, guessed: true }),
];

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  listCatalogProviders.mockReset().mockResolvedValue({ items: CATALOG });
  importCatalogProvider.mockReset().mockResolvedValue({ provider: {}, models_imported: 1 });
  getManagedUsage.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><MemoryRouter>{node}</MemoryRouter></I18nProvider></QueryClientProvider>);
  });
  for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); };
const settle = async () => { for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
describe('CatalogImportCard', () => {
  it('lists rejected entries last, greyed with the reason and no import button', async () => {
    const container = await render(<CatalogImportCard configuredIds={new Set()} onImported={vi.fn()} />);
    const rows = [...container.querySelectorAll('[data-catalog-row]')].map((row) => row.getAttribute('data-catalog-row'));
    expect(rows).toEqual(['azure', 'groq', 'bedrock', 'fireworks']);
    const rejected = container.querySelector('[data-catalog-row="bedrock"]')!;
    expect(rejected.textContent).toContain('Needs AWS signing.');
    expect(rejected.querySelector('button')).toBeNull();
  });

  it('says why an entry is rejected in the reader’s language, keeping the raw reason as the tooltip', async () => {
    const container = await render(<CatalogImportCard configuredIds={new Set()} onImported={vi.fn()} />);
    const coded = container.querySelector('[data-catalog-row="fireworks"] [data-catalog-reject-reason]')!;
    expect(coded.textContent).toBe('This provider only offers its own SDK, which Kiki cannot use.');
    expect(coded.getAttribute('title')).toBe('proprietary-sdk');
    // A server that only explains the entry in its own words still shows them.
    const prose = container.querySelector('[data-catalog-row="bedrock"] [data-catalog-reject-reason]')!;
    expect(prose.textContent).toBe('Needs AWS signing.');
    expect(prose.getAttribute('title')).toBe('Needs AWS signing.');
  });

  it('filters by name or id and says when nothing matches', async () => {
    const container = await render(<CatalogImportCard configuredIds={new Set()} onImported={vi.fn()} />);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(search, 'gro');
    expect(container.querySelectorAll('[data-catalog-row]')).toHaveLength(1);
    await type(search, 'nothing');
    expect(container.querySelector('[data-catalog-no-match]')?.textContent).toContain('nothing');
  });

  it('requires a base URL before importing an entry without one, then imports and reports the count', async () => {
    const onImported = vi.fn().mockResolvedValue(undefined);
    const container = await render(<CatalogImportCard configuredIds={new Set()} onImported={onImported} />);
    await click(container.querySelector('[data-catalog-row="azure"] button'));
    expect(container.querySelector('[data-catalog-form="azure"]')?.textContent).toContain('inferred');
    await click(container.querySelector('[data-catalog-import]'));
    expect(importCatalogProvider).not.toHaveBeenCalled();
    expect(container.querySelector('[data-catalog-base-url]')?.getAttribute('aria-invalid')).toBe('true');
    await type(container.querySelector<HTMLInputElement>('[data-catalog-base-url]')!, 'https://r.example.test/v1');
    await click(container.querySelector('[data-catalog-import]'));
    await settle();
    expect(importCatalogProvider).toHaveBeenCalledExactlyOnceWith({ catalog_id: 'azure', base_url: 'https://r.example.test/v1' });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-feedback-tone="success"]')?.textContent).toBe('Imported AZURE with 1 model.');
  });

  it('warns that importing an existing id refreshes it', async () => {
    const container = await render(<CatalogImportCard configuredIds={new Set(['groq'])} onImported={vi.fn()} />);
    const row = container.querySelector('[data-catalog-row="groq"]')!;
    expect(row.textContent).toContain('Configured');
    await click(row.querySelector('button'));
    expect(container.querySelector('[data-catalog-refresh]')?.textContent).toContain('“groq” already exists');
    expect(container.querySelector('[data-catalog-import]')?.textContent).toBe('Re-import GROQ');
  });

  it('keeps the form open with the server reason when the import fails', async () => {
    importCatalogProvider.mockRejectedValue(new Error('upstream refused the key'));
    const container = await render(<CatalogImportCard configuredIds={new Set()} onImported={vi.fn()} />);
    await click(container.querySelector('[data-catalog-row="groq"] button'));
    await click(container.querySelector('[data-catalog-import]'));
    await settle();
    expect(container.querySelector('[data-catalog-form="groq"] [role="alert"]')?.textContent).toContain('upstream refused the key');
  });
});

const method = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, label: id, provider: `managed:${id}`, protocol: 'openai', signed_in: true,
  account: { state: 'unknown' }, quota: { state: 'unknown' }, ...overrides,
}) as never;

describe('AccountQuotaCard', () => {
  it('renders nothing when no account is signed in', async () => {
    const container = await render(<AccountQuotaCard methods={[method('kimi-code', { signed_in: false })]} />);
    expect(container.querySelector('#st-card-account-quota')).toBeNull();
  });

  it('draws Kimi Code windows, amber at 80%, and never divides by a zero limit', async () => {
    getManagedUsage.mockResolvedValue({
      kind: 'ok',
      summary: { name: 'Weekly', used: 90, limit: 100 },
      limits: [{ name: 'Burst', window: { duration: 5, unit: 'hour' }, used: 10, limit: 100 }, { name: 'Unmetered', used: 3, limit: 0 }],
      extra_usage: null,
    });
    const container = await render(<AccountQuotaCard methods={[method('kimi-code')]} />);
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
    const rows = [...container.querySelectorAll('[data-quota-row]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute('data-quota-near')).toBe('true');
    expect(rows[1]!.getAttribute('data-quota-near')).toBeNull();
    expect(rows[1]!.textContent).toContain('per 5 h');
    expect(rows[2]!.querySelector('[role="progressbar"]')).toBeNull();
    expect(rows[2]!.textContent).toContain('3 used');
    expect(container.textContent).toContain('not this session’s token use');
  });

  it('shows the vendor message when usage cannot be read, and the status quota for other accounts', async () => {
    getManagedUsage.mockResolvedValue({ kind: 'error', message: 'token expired' });
    const container = await render(<AccountQuotaCard methods={[
      method('kimi-code'),
      method('github-copilot', { quota: { state: 'known', label: 'Premium', remaining: 12, unit: 'count' } }),
    ]} />);
    expect(container.querySelector('[data-quota-account="kimi-code"] [role="alert"]')?.textContent).toContain('token expired');
    expect(container.querySelector('[data-quota-account="github-copilot"]')?.textContent).toContain('12 left');
    expect(getManagedUsage).toHaveBeenCalledTimes(1);
  });
});
