// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { KikiClient, MEMORY_TYPES, type MemoryEntry } from '../lib/client';
import { MemoryPage } from './MemoryPage';

const client = new KikiClient({ baseUrl: 'http://example.test', token: 'example-token' });
vi.mock('../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => undefined,
}));

const entries: MemoryEntry[] = MEMORY_TYPES.flatMap((type) =>
  (['match', 'other', 'archived'] as const).map((variant) => ({
    id: `m_${type}_${variant}`,
    type,
    title: `${type} ${variant}`,
    body: variant === 'other' ? 'Unrelated content.' : 'Needle content.',
    status: variant === 'archived' ? 'archived' : 'active',
    pinned: false,
    created: '2026-01-01T12:00:00Z',
    updated: '2026-01-01T12:00:00Z',
    source: { writer: 'user' },
    reason: 'Test memory filters',
    revision: 'revision-example',
  })),
);
const requests: URL[] = [];
const mounted: { root: Root; container: HTMLDivElement; queryClient: QueryClient }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  requests.length = 0;
  vi.spyOn(client, 'listPersonas').mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    let data: unknown;
    if (url.pathname === '/api/memory/settings') {
      data = { enabled: true, approval: 'auto', budget: 2000, workspaces: {} };
    } else {
      expect(url.pathname).toBe('/api/memory/global');
      requests.push(url);
      const type = url.searchParams.get('type');
      const query = url.searchParams.get('query')?.toLowerCase() ?? '';
      const includeInactive = url.searchParams.get('include_inactive') === 'true';
      data = { items: entries.filter((entry) =>
        (type === null || entry.type === type)
        && (includeInactive || entry.status === 'active')
        && `${entry.title} ${entry.body}`.toLowerCase().includes(query)) };
    }
    return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
});
afterEach(async () => {
  for (const { root, container, queryClient } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container, queryClient });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/memory']}>
            <MemoryPage workspaceOptions={[]} onNavigate={() => {}} onToggleSidebar={() => {}} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function rowIds(container: HTMLElement) {
  return [...container.querySelectorAll('[data-memory-row]')].map((row) => row.getAttribute('data-memory-row')).sort();
}

async function selectType(container: HTMLElement, type: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-memory-type-filter="${type}"]`)!;
  await act(async () => { button.click(); });
  await flush();
  expect(button.getAttribute('aria-pressed')).toBe('true');
}

async function search(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-memory-search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function toggleInactive(container: HTMLElement) {
  await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await flush();
}

describe('MemoryPage filters', () => {
  it('sends each type to the server and replaces the rows, with all restoring the full active list', async () => {
    const container = await renderPage();
    const activeIds = entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort();
    expect(rowIds(container)).toEqual(activeIds);
    for (const type of MEMORY_TYPES) {
      await selectType(container, type);
      expect(requests.at(-1)!.searchParams.get('type')).toBe(type);
      expect(rowIds(container)).toEqual([`m_${type}_match`, `m_${type}_other`]);
    }
    await selectType(container, 'all');
    expect(rowIds(container)).toEqual(activeIds);
    expect(requests[0]!.searchParams.has('type')).toBe(false);
  });

  it('combines each type and all with search and show archived', async () => {
    const container = await renderPage();
    await search(container, '  needle  ');
    for (const type of MEMORY_TYPES) {
      await selectType(container, type);
      expect(rowIds(container)).toEqual([`m_${type}_match`]);
      await toggleInactive(container);
      expect(rowIds(container)).toEqual([`m_${type}_archived`, `m_${type}_match`]);
      expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({ type, query: 'needle', include_inactive: 'true' });
      await toggleInactive(container);
    }
    await selectType(container, 'all');
    expect(rowIds(container)).toEqual(MEMORY_TYPES.map((type) => `m_${type}_match`).sort());
    await toggleInactive(container);
    expect(rowIds(container)).toEqual(entries.filter((entry) => entry.body.includes('Needle')).map((entry) => entry.id).sort());
    expect(requests.at(-1)!.searchParams.has('type')).toBe(false);
  });

  it('shows the filtered empty state and clears all filters back to the full list', async () => {
    const container = await renderPage();
    await selectType(container, 'reference');
    await toggleInactive(container);
    await search(container, 'absent');
    expect(rowIds(container)).toEqual([]);
    const empty = container.querySelector('[data-memory-empty]')!;
    expect(empty.textContent).toContain('Nothing matches these filters.');
    await act(async () => { empty.querySelector<HTMLButtonElement>('button')!.click(); });
    await flush();
    expect(container.querySelector('[data-memory-empty]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-memory-search]')!.value).toBe('');
    expect(container.querySelector('[data-memory-type-filter="all"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(rowIds(container)).toEqual(entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort());
  });
});
