// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SearchIndexStatusCard } from './SearchIndexStatusCard';

const searchMessages = vi.fn();
const retrySearchIndexer = vi.fn(async () => ({ retried: true }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { searchMessages, retrySearchIndexer } }),
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
  searchMessages.mockReset();
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
}

describe('SearchIndexStatusCard', () => {
  it('says the indexer ran out of memory and restarts it on request', async () => {
    searchMessages.mockResolvedValueOnce(page({ state: 'unavailable', reason: 'memory_budget' }));
    searchMessages.mockResolvedValue(page({ state: 'ready', indexed_sessions: 3 }));
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
    searchMessages.mockResolvedValue(page({ state: 'unavailable', reason: 'disabled' }));
    await render();
    expect(container.querySelector('[data-search-index-retry]')).toBeNull();
    expect(container.textContent).toContain('Full-text search is off');
  });
});
