// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/protocol';

import { I18nProvider } from '../i18n';
import type { SearchMessageHit, SearchMessagesResponse } from '../lib/client';
import { SEARCH_DEBOUNCE_MS } from '../lib/search';
import { SESSION_PIN_META_KEY, type SessionGroup } from '../lib/sessionList';
import {
  mergeSearchPages,
  searchNextPageParam,
  Sidebar,
} from './Sidebar';

const searchMessages = vi.fn();

vi.mock('../state/connection', () => ({
  useOptionalControllerRegistry: () => null,
  useConnection: () => ({
    client: { searchMessages },
    meta: {
      server_version: '1.0.0',
      capabilities: {
        websocket: true,
        file_upload: true,
        fs_query: true,
        mcp: true,
        tasks: true,
        terminal: true,
      },
      server_id: 'srv_test',
      started_at: '2026-01-01T00:00:00.000Z',
      open_in_apps: [],
      dangerous_bypass_auth: false,
    },
    wsStatus: 'open',
    disconnect: () => {},
  }),
}));

function hit(overrides: Partial<SearchMessageHit> & Pick<SearchMessageHit, 'session_id'>): SearchMessageHit {
  return {
    workspace_id: 'ws_test',
    session_title: overrides.session_id,
    agent_id: 'main',
    role: 'user',
    snippet: `snippet ${overrides.session_id}`,
    time: 1_735_689_600_000,
    score: 1,
    ...overrides,
  };
}

function page(
  items: SearchMessageHit[],
  hasMore: boolean,
  token?: string,
  overrides: Partial<SearchMessagesResponse> = {},
): SearchMessagesResponse {
  return {
    items,
    has_more: hasMore,
    page_token: token,
    index_state: { state: 'ready', indexed_sessions: 3, total_sessions: 3, documents: 3 },
    source: 'index',
    ...overrides,
  };
}

const A1 = hit({ session_id: 's1', snippet: 'alpha one', turn: 0 });
const A2 = hit({ session_id: 's2', snippet: 'alpha two', step_id: 't1.0' });
const A3 = hit({ session_id: 's3', snippet: 'alpha three', turn: 1 });
const B1 = hit({ session_id: 's4', snippet: 'beta one', turn: 0 });

function session(id: string): Session {
  return {
    id,
    workspace_id: 'ws_test',
    title: id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: 'C:/tmp' },
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
    message_count: 0,
    last_seq: 0,
  };
}

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  searchMessages.mockReset();
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(
  list: { sessions?: readonly Session[]; sessionGroups?: readonly SessionGroup[] } = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <Sidebar
              activeSessionId={undefined}
              sessions={list.sessions ?? []}
              sessionGroups={list.sessionGroups ?? []}
              sessionsQuery={{
                isLoading: false,
                isError: false,
                error: null,
                hasNextPage: false,
                isFetchingNextPage: false,
                fetchNextPage: async () => {},
              }}
              workspaceOptions={[]}
              workspaceFilter={undefined}
              onWorkspaceFilter={() => {}}
              showArchived={false}
              onToggleArchived={() => {}}
              onNewSession={() => {}}
              groupBy="time"
              onGroupBy={() => {}}
              sortBy="updated-desc"
              onSortBy={() => {}}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

async function typeQuery(container: HTMLDivElement, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-search-box]');
  if (input === null) throw new Error('search box not rendered');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
  });
}

async function waitForText(container: HTMLDivElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await settle();
  }
  throw new Error(`"${text}" never rendered`);
}

describe('Sidebar global search pagination', () => {
  it('appends the second page instead of replacing the first', async () => {
    searchMessages.mockImplementation(async (body: { query: string; page_token?: string }) => {
      if (body.query !== 'alpha') return page([], false);
      return body.page_token === 'tok1'
        ? page([A2, A3], false)
        : page([A1, A2], true, 'tok1');
    });

    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');

    const loadMore = container.querySelector<HTMLButtonElement>('[data-search-load-more]');
    expect(loadMore).not.toBeNull();
    await act(async () => {
      loadMore?.click();
    });
    await waitForText(container, 'alpha three');

    const body = container.textContent ?? '';
    expect(body).toContain('alpha one');
    expect(body).toContain('alpha two');
    expect(body).toContain('alpha three');
    // The cross-page duplicate (A2) is kept on both pages.
    const a2 = [...container.querySelectorAll('button')].filter((el) => el.textContent?.includes('alpha two'));
    expect(a2).toHaveLength(2);
    // Final page (`has_more: false`) removes the button.
    expect(container.querySelector('[data-search-load-more]')).toBeNull();

    const tokens = searchMessages.mock.calls
      .filter(([call]) => (call as { query: string }).query === 'alpha')
      .map(([call]) => (call as { page_token?: string }).page_token);
    expect(tokens).toEqual([undefined, 'tok1']);
  });

  it('starts from the first page again when the query changes', async () => {
    searchMessages.mockImplementation(async (body: { query: string; page_token?: string }) => {
      if (body.query === 'alpha') {
        return body.page_token === 'tok1'
          ? page([A2, A3], false)
          : page([A1, A2], true, 'tok1');
      }
      if (body.query === 'beta') return page([B1], false);
      return page([], false);
    });

    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-search-load-more]')?.click();
    });
    await waitForText(container, 'alpha three');

    await typeQuery(container, 'beta');
    await waitForText(container, 'beta one');

    const body = container.textContent ?? '';
    expect(body).toContain('beta one');
    expect(body).not.toContain('alpha one');
    expect(body).not.toContain('alpha three');

    const betaCalls = searchMessages.mock.calls
      .filter(([call]) => (call as { query: string }).query === 'beta')
      .map(([call]) => (call as { page_token?: string }).page_token);
    expect(betaCalls).toEqual([undefined]);
  });

  it('hides load-more and never requests page two when has_more is false', async () => {
    searchMessages.mockResolvedValue(page([B1], false));

    const { container } = await mount();
    await typeQuery(container, 'beta');
    await waitForText(container, 'beta one');

    expect(container.querySelector('[data-search-load-more]')).toBeNull();
    expect(searchMessages).toHaveBeenCalledTimes(1);
  });

  it('guards against duplicate load-more requests while a page is fetching', async () => {
    let resolvePageTwo: (value: SearchMessagesResponse) => void = () => {};
    const pendingPageTwo = new Promise<SearchMessagesResponse>((resolve) => {
      resolvePageTwo = resolve;
    });
    searchMessages.mockImplementation(async (body: { query: string; page_token?: string }) => {
      if (body.query !== 'alpha') return page([], false);
      return body.page_token === 'tok1' ? pendingPageTwo : page([A1, A2], true, 'tok1');
    });

    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');

    const loadMore = () => container.querySelector<HTMLButtonElement>('[data-search-load-more]');
    await act(async () => {
      loadMore()?.click();
    });
    await settle();
    // While page two is in flight the button exists but is disabled; a second
    // click is a no-op and must not start another request.
    const disabled = loadMore();
    expect(disabled?.disabled).toBe(true);
    await act(async () => {
      disabled?.click();
    });
    await settle();

    resolvePageTwo(page([A3], false));
    await waitForText(container, 'alpha three');

    const pageTwoCalls = searchMessages.mock.calls.filter(
      ([call]) =>
        (call as { query: string }).query === 'alpha' &&
        (call as { page_token?: string }).page_token === 'tok1',
    );
    expect(pageTwoCalls).toHaveLength(1);
  });

  it('keeps rendered pages and offers a retry when the next page fails', async () => {
    let rejectPageTwo: (error: Error) => void = () => {};
    let pageTwoAttempts = 0;
    searchMessages.mockImplementation(async (body: { query: string; page_token?: string }) => {
      if (body.query !== 'alpha') return page([], false);
      if (body.page_token !== 'tok1') return page([A1, A2], true, 'tok1');
      pageTwoAttempts += 1;
      if (pageTwoAttempts === 1) {
        return new Promise<SearchMessagesResponse>((_resolve, reject) => {
          rejectPageTwo = reject;
        });
      }
      return page([A3], false);
    });

    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-search-load-more]')?.click();
    });
    // A rejected "load more" must not hide the first page.
    await act(async () => {
      rejectPageTwo(new Error('pagination failed'));
    });
    await settle();

    const body = container.textContent ?? '';
    expect(body).toContain('alpha one');
    expect(body).toContain('alpha two');
    expect(body).not.toContain('alpha three');
    // `hasNextPage` stays true (the last successful page still has_more), so
    // load-more remains; the retry affordance is the explicit error entrypoint.
    const retry = container.querySelector<HTMLButtonElement>('[data-search-retry]');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
    });
    await waitForText(container, 'alpha three');

    expect(container.textContent ?? '').not.toContain('Search failed');
    expect(container.querySelector('[data-search-retry]')).toBeNull();
    expect(pageTwoAttempts).toBe(2);
  });

  it('keeps the incomplete warning when an earlier page is incomplete but the last is not', async () => {
    searchMessages.mockImplementation(async (body: { query: string; page_token?: string }) => {
      if (body.query !== 'alpha') return page([], false);
      if (body.page_token === 'tok1') {
        return page([A3], false, undefined, {
          index_state: { state: 'ready', indexed_sessions: 3, total_sessions: 3, documents: 3 },
        });
      }
      return page([A1], true, 'tok1', {
        incomplete: 'postings_budget',
        index_state: { state: 'ready', indexed_sessions: 3, total_sessions: 3, documents: 3 },
      });
    });

    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-search-load-more]')?.click();
    });
    await waitForText(container, 'alpha three');

    expect(container.textContent ?? '').toContain('Results may be incomplete');
  });
});

describe('Sidebar entry distribution', () => {
  it('puts capabilities and usage on the wordmark row', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-nav-capabilities]')).not.toBeNull();
    expect(container.querySelector('[data-nav-usage]')).not.toBeNull();
  });

  it('keeps only settings and the connection status dot in the footer', async () => {
    const { container } = await mount();
    const status = container.querySelector<HTMLButtonElement>('[data-connection-status]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('title')).toContain('1.0.0');
    // Disconnect moved to settings → connection.
    expect(container.textContent ?? '').not.toContain('Disconnect');
  });

  it('offers a quick pin toggle per row and labels it from the pin state', async () => {
    const plain = session('plain');
    const pinned: Session = {
      ...session('pinned'),
      metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true },
    };
    const groups: SessionGroup[] = [
      { key: 'pinned', label: 'Pinned', items: [pinned] },
      { key: 'week', label: 'Past 7 days', items: [plain] },
    ];
    const { container } = await mount({ sessions: [pinned, plain], sessionGroups: groups });
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('[data-session-pin-toggle]')];
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.getAttribute('aria-label')).toBe('Unpin pinned');
    expect(toggles[1]?.getAttribute('aria-label')).toBe('Pin plain to the top');
  });
});

describe('mergeSearchPages', () => {
  it('appends pages in server order and keeps a duplicate re-ranked across a page boundary', () => {
    const p1 = hit({ session_id: 'x', turn: 0 });
    const p2 = hit({ session_id: 'y', turn: 1 });
    const p3 = hit({ session_id: 'z', turn: 2 });
    const merged = mergeSearchPages([page([p1, p2], true, 't1'), page([p2, p3], false)]);
    expect(merged.map((value) => value.session_id)).toEqual(['x', 'y', 'y', 'z']);
  });

  it('keeps distinct title docs that carry no turn or step id in order', () => {
    const titleA = hit({ session_id: 'x', role: 'title', snippet: 'doc a' });
    const titleB = hit({ session_id: 'x', role: 'title', snippet: 'doc b' });
    expect(
      mergeSearchPages([page([titleA], true, 't1'), page([titleB], false)]).map(
        (value) => value.snippet,
      ),
    ).toEqual(['doc a', 'doc b']);
  });

  it('keeps distinct frames sharing a step_id and retains the same object across pages', () => {
    const frameOne = hit({ session_id: 'x', role: 'assistant', step_id: 't1.1', snippet: 'first frame' });
    const frameTwo = hit({ session_id: 'x', role: 'assistant', step_id: 't1.1', snippet: 'second frame' });
    // Same step, different text: both kept in server order.
    expect(
      mergeSearchPages([page([frameOne, frameTwo], false)]).map((value) => value.snippet),
    ).toEqual(['first frame', 'second frame']);
    // Byte-identical row re-ranked onto the next page: kept on both pages.
    expect(
      mergeSearchPages([page([frameOne], true, 't1'), page([frameOne], false)]),
    ).toHaveLength(2);
  });
});

describe('searchNextPageParam', () => {
  it('forwards the cursor while has_more and returns undefined on the final page', () => {
    expect(searchNextPageParam(page([A1], true, 'tok1'))).toBe('tok1');
    expect(searchNextPageParam(page([A1], false))).toBeUndefined();
  });
});