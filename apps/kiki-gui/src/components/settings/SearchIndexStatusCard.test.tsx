// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SearchIndexStatusCard } from './SearchIndexStatusCard';

const searchIndexStatus = vi.fn();
const retrySearchIndexer = vi.fn(async () => ({ retried: true }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { searchIndexStatus, retrySearchIndexer } }),
}));

const page = (index_state: Record<string, unknown>) => ({
  items: [],
  has_more: false,
  index_state: { indexed_sessions: 1, total_sessions: 3, documents: 0, ...index_state },
  source: 'index',
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  searchIndexStatus.mockReset();
  retrySearchIndexer.mockClear();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider><SearchIndexStatusCard /></I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return client;
}

describe('SearchIndexStatusCard', () => {
  it('renders pushed progress and completion without polling', async () => {
    searchIndexStatus.mockResolvedValue(page({ state: 'building' }));
    const cache = await render();
    vi.useFakeTimers();
    try {
      await act(async () => {
        cache.setQueryData(['search-index-state'], page({ state: 'building', indexed_sessions: 2 }).index_state);
        await vi.advanceTimersByTimeAsync(3001);
      });
      expect(container.textContent).toContain('2 of 3');
      const bar = container.querySelector<HTMLElement>('[role="progressbar"]')!;
      expect(bar.getAttribute('aria-valuenow')).toBe('2');
      expect(bar.getAttribute('aria-valuemax')).toBe('3');
      expect(searchIndexStatus).toHaveBeenCalledTimes(1);
      await act(async () => {
        cache.setQueryData(['search-index-state'], page({ state: 'ready', indexed_sessions: 3 }).index_state);
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(container.querySelector<HTMLElement>('[data-search-index-status]')!.dataset['searchIndexStatus']).toBe('ready');
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
      expect(searchIndexStatus).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('says the indexer ran out of memory and restarts it on request', async () => {
    searchIndexStatus.mockResolvedValueOnce(page({ state: 'unavailable', reason: 'memory_budget' }));
    searchIndexStatus.mockResolvedValue(page({ state: 'ready', indexed_sessions: 3 }));
    await render();
    const card = container.querySelector<HTMLElement>('[data-search-index-status]')!;
    expect(card.dataset['searchIndexReason']).toBe('memory_budget');
    expect(card.textContent).toContain('exceeded its memory budget');
    const retry = container.querySelector<HTMLButtonElement>('[data-search-index-retry]')!;
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(retrySearchIndexer).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>('[data-search-index-status]')!.dataset['searchIndexStatus']).toBe('ready');
    expect(container.textContent).toContain('Indexer restarted');
  });

  it('offers no restart when search is switched off', async () => {
    searchIndexStatus.mockResolvedValue(page({ state: 'unavailable', reason: 'disabled' }));
    await render();
    expect(container.querySelector('[data-search-index-retry]')).toBeNull();
    expect(container.textContent).toContain('Full-text search is off');
  });
});
