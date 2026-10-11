// @vitest-environment jsdom

/**
 * Ctrl+K content search: an index the server cannot serve, or a read that
 * failed, is not "no sessions match" — the switcher says which and offers the
 * same retry the sidebar has, while the local title matches and the typed
 * query stay put.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { QuickSwitcher } from './QuickSwitcher';

const { client } = vi.hoisted(() => ({
  client: { searchMessages: vi.fn(), retrySearchIndexer: vi.fn() },
}));
vi.mock('../state/connection', () => ({ useConnection: () => ({ client }), useOptionalConnection: () => ({ client }) }));

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout: the switcher scrolls the active row into view.
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  document.body.innerHTML = '';
  client.searchMessages.mockReset();
  client.retrySearchIndexer.mockReset();
});

function session(id: string, title: string): Session {
  return {
    id,
    workspace_id: 'wd_fixture_000000000000',
    title,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: 'C:/fixture/workshop' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 2,
    last_seq: 10,
  } as Session;
}

const sessions = [session('session_alpha', 'Alpha cache notes'), session('session_beta', 'Beta roadmap')];

function searchPage(indexState: Record<string, unknown>, items: readonly unknown[] = []): never {
  return { items, has_more: false, source: 'index', index_state: indexState } as never;
}

const readyPage = () => searchPage({ state: 'ready', indexed_sessions: 2, total_sessions: 2, documents: 4 });
const hit = {
  session_id: 'session_beta',
  workspace_id: 'wd_fixture_000000000000',
  session_title: 'Beta roadmap',
  agent_id: 'main',
  role: 'assistant' as const,
  snippet: 'the cache lives here',
  time: Date.parse('2026-01-01T00:00:00.000Z'),
  turn: 3,
  score: 1,
};

async function mount(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <I18nProvider>
            <QuickSwitcher sessions={sessions} onClose={() => {}} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** Poll until the predicate holds (the content layer settles after a debounce). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`${label} never rendered; the switcher showed: ${document.body.textContent ?? ''}`);
}

/** Type into the switcher's own field (the dialog is portaled into body). */
async function typeQuery(value: string): Promise<HTMLInputElement> {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(400);
  return input;
}

const has = (selector: string) => () => document.querySelector(selector) !== null;
const hasText = (text: string) => () => document.body.textContent?.includes(text) === true;
const gone = (selector: string) => () => document.querySelector(selector) === null;
const rows = () => document.querySelectorAll('#quick-switcher-list [role="option"]').length;

describe('quick switcher content search', () => {
  // 'cache' keeps a local title match beside the failure; 'distant' matches
  // nothing local, which is the state the old switcher answered with "no
  // sessions match" although the content search had only failed — that second
  // case is what the fix has to be judged on.
  it.each(['cache', 'distant'])('states a failed read instead of "no sessions match" (%s) and retries without losing the query', async (query) => {
    client.searchMessages
      .mockRejectedValueOnce(new Error('network is unreachable'))
      .mockResolvedValue(searchPage({ state: 'ready', indexed_sessions: 2, total_sessions: 2, documents: 4 }, [hit]));
    await mount();
    const input = await typeQuery(query);
    expect(client.searchMessages).toHaveBeenCalledTimes(1);
    if (query === 'cache') await waitFor(hasText('Alpha cache notes'), 'the local title match');
    else expect(rows()).toBe(0);
    await waitFor(has('[data-search-error]'), 'the failed-read state');
    expect(document.querySelector('[data-switcher-search-status]')).not.toBeNull();
    expect(document.body.textContent).toContain('network is unreachable');
    expect(document.body.textContent).not.toContain('No sessions match');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-search-initial-retry]')!.click(); });
    await waitFor(hasText('the cache lives here'), 'the hit the retry read');
    await waitFor(gone('[data-search-error]'), 'the failed-read state to clear');
    expect(client.searchMessages).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('No sessions match');
    expect(input.value).toBe(query);
  });

  it('states an unavailable index, keeps the local matches, and retries the indexer', async () => {
    client.retrySearchIndexer.mockResolvedValue({} as never);
    client.searchMessages
      .mockResolvedValueOnce(searchPage({ state: 'unavailable', reason: 'indexer_backoff' }))
      .mockResolvedValue(searchPage({ state: 'ready', indexed_sessions: 2, total_sessions: 2, documents: 4 }, [hit]));
    await mount();
    const input = await typeQuery('cache');
    await waitFor(hasText('Alpha cache notes'), 'the local title match');
    await waitFor(has('[data-search-unavailable]'), 'the unavailable-index state');
    expect(document.querySelector('[data-search-unavailable]')?.textContent).toContain('indexer is backing off');
    expect(document.body.textContent).not.toContain('No sessions match');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-search-unavailable-retry]')!.click(); });
    await waitFor(hasText('the cache lives here'), 'the hit the retried index returned');
    expect(client.retrySearchIndexer).toHaveBeenCalledTimes(1);
    await waitFor(gone('[data-search-unavailable]'), 'the unavailable-index state to clear');
    expect(input.value).toBe('cache');
  });

  it('still claims an empty result when the search really answered with none', async () => {
    client.searchMessages.mockResolvedValue(readyPage());
    await mount();
    await typeQuery('persimmon');
    expect(document.querySelector('[data-search-error]')).toBeNull();
    expect(document.querySelector('[data-search-unavailable]')).toBeNull();
    expect(document.querySelector('[data-switcher-search-status]')).toBeNull();
    expect(document.body.textContent).toContain('No sessions match');
  });
});
