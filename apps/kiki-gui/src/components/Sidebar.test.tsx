// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoomDocument, RoomListItem, Session, Workspace } from '@kiki/protocol';

import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  isPinnedSession,
  mergeConversationItems,
  SESSION_PIN_META_KEY,
  type ConversationListItem,
  type SessionGroup,
} from '@kiki/session-core/sessions';
import { subscribeComposerInserts } from '@kiki/session-core/composer';
import {
  DEFAULT_SESSION_LIST_FILTERS,
  markSessionSeen,
  readLayoutPreferences,
  writeLayoutPreferences,
  resetSessionSeen,
} from '@kiki/session-core/settings';
import { HostProvider, browserHost, type HostAdapter } from '../host';
import { I18nProvider } from '../i18n';
import type { SearchMessageHit, SearchMessagesResponse } from '../lib/client';
import { nestSessionThreads, sessionRelationOf } from '../lib/sessionThreads';
import { requestSessionSearch } from '../lib/sidebarSearch';
import { configureSpaceStorage } from '../lib/spaceStorage';
import { readWorkspaceGroupMemory, writeWorkspaceGroupMemory } from '../lib/sidebarGroupMemory';
import {
  mergeSearchPages,
  searchNextPageParam,
  Sidebar,
} from './Sidebar';

const searchMessages = vi.fn();
const getSession = vi.fn<(id: string) => Promise<Session>>();
const retrySearchIndexer = vi.fn(async () => ({ retried: true }));
const setWorkspacePinned = vi.fn(async () => {});
const listEphemeralSessions = vi.fn(async (_query?: { before_id?: string; page_size?: number }): Promise<{ items: Session[]; has_more?: boolean; next_cursor?: string }> => ({ items: [] }));
/** The persona roster the 角色 group reads; empty unless a test wants one. */
const listPersonas = vi.fn(async (): Promise<readonly unknown[]> => []);
const connectionScope = vi.hoisted(() => ({ id: 'local' }));
const listTasks = vi.fn(async (): Promise<{ items: unknown[] }> => ({ items: [] }));
const listPrompts = vi.fn(async (): Promise<unknown> => ({ active: null, queued: [] }));
// The room rows' lifecycle calls; wired into the mocked client's klient.rest.
const roomRest = vi.hoisted(() => ({
  list: vi.fn(),
  addMember: vi.fn(),
  createFromThreads: vi.fn(),
  searchThreads: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  pause: vi.fn(),
  continue: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useOptionalControllerRegistry: () => null,
  useOptionalConnection: () => ({ client: { getSession } }),
  useConnection: () => ({
    client: {
      getRequestGovernance: async () => ({ domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z', active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' }, dimensions: [], rules: [], waiting: [] }),
      searchMessages,
      retrySearchIndexer,
      setWorkspacePinned,
      listEphemeralSessions,
      listTasks,
      listPrompts,
      listPersonas,
      klient: { rest: { rooms: roomRest } },
    },
    scopeId: connectionScope.id,
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

/** Wrap a plain session the way useConversationList would; the sidebar only
 * reads the thread fields off `session`, so the conversation fields just
 * mirror it. */
function threadItem(session: Session): ConversationListItem {
  return {
    ...session,
    kind: 'session',
    session,
    key: `session:${session.id}`,
    href: `/s/${session.id}`,
    unread_count: session.last_seq,
    needs_you: session.pending_interaction === 'approval' || session.pending_interaction === 'question',
    failed: session.last_turn_reason === 'failed',
    pinned: isPinnedSession(session),
  };
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  searchMessages.mockReset();
  getSession.mockReset();
  getSession.mockRejectedValue(new Error('Thread not found'));
  retrySearchIndexer.mockClear();
  setWorkspacePinned.mockClear();
  listEphemeralSessions.mockReset();
  listEphemeralSessions.mockResolvedValue({ items: [] });
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
  for (const fn of Object.values(roomRest)) fn.mockReset();
  connectionScope.id = 'local';
  // Workspace folds and the list scroll persist across mounts.
  localStorage.removeItem('kiki.sidebar.workspaceGroups');
  localStorage.removeItem('kiki.sidebar.topLevelThreads');
  configureSpaceStorage(null);
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  resetSessionSeen();
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

type SidebarProps = ComponentProps<typeof Sidebar>;

/** Tests still hand the mount plain session groups; the wrap into
 * conversation items happens here so every body keeps its old shape. */
type SidebarOverrides = Omit<Partial<SidebarProps>, 'sessionGroups'> & {
  sessionGroups?: readonly SessionGroup<Session | ConversationListItem>[];
};

async function mount(
  overrides: SidebarOverrides = {},
  host: HostAdapter = browserHost,
  cachedSessions: readonly Session[] = [],
): Promise<{ container: HTMLDivElement; root: Root; queryClient: QueryClient }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedSessions.length > 0) client.setQueryData(['sessions', 'cached'], { pages: [{ items: cachedSessions }] });
  const { sessionGroups: rawGroups, ...rest } = overrides;
  const sessionGroups = (rawGroups ?? []).map((group) => ({
    ...group,
    items: group.items.map((item) => ('kind' in item ? item : threadItem(item))),
  }));
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <HostProvider host={host}>
            <MemoryRouter>
              <Sidebar
                activeSessionId={undefined}
                sessions={[]}
                sessionGroups={sessionGroups}
                sessionsQuery={{
                  isLoading: false,
                  isError: false,
                  error: null,
                  hasNextPage: false,
                  isFetchingNextPage: false,
                  fetchNextPage: async () => {},
                }}
                workspaceOptions={[]}
                filters={DEFAULT_SESSION_LIST_FILTERS}
                onFiltersChange={() => {}}
                onNewSession={() => {}}
                groupBy="time"
                onGroupBy={() => {}}
                sortBy="updated-desc"
                onSortBy={() => {}}
                {...rest}
              />
            </MemoryRouter>
          </HostProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root, queryClient: client };
}

function workspace(id: string, name: string, pinned = false): Workspace {
  return {
    id,
    root: `C:/${name}`,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: '2026-01-02T00:00:00.000Z',
    session_count: 1,
    pinned,
    isGit: false,
  };
}

/** The view menu lives behind the ⋮ trigger; every test that inspects an
 * option has to open it first. */
async function openViewMenu(container: HTMLDivElement): Promise<HTMLElement> {
  const toggle = container.querySelector<HTMLButtonElement>('[data-view-menu-toggle]');
  if (toggle === null) throw new Error('view menu trigger not rendered');
  await act(async () => {
    toggle.click();
  });
  const menu = container.querySelector<HTMLElement>('[data-view-menu]');
  if (menu === null) throw new Error('view menu did not open');
  return menu;
}

async function openFilterMenu(container: HTMLDivElement): Promise<HTMLElement> {
  const toggle = container.querySelector<HTMLButtonElement>('[data-filter-menu-toggle]');
  if (toggle === null) throw new Error('filter menu trigger not rendered');
  await act(async () => {
    toggle.click();
  });
  const menu = container.querySelector<HTMLElement>('[data-filter-menu]');
  if (menu === null) throw new Error('filter menu did not open');
  return menu;
}

async function typeQuery(container: HTMLDivElement, text: string): Promise<void> {
  // The field lives behind the header's search icon; open it first.
  if (container.querySelector('[data-search-box]') === null) {
    const toggle = container.querySelector<HTMLButtonElement>('[data-search-toggle]');
    if (toggle === null) throw new Error('search toggle not rendered');
    await act(async () => { toggle.click(); });
  }
  const input = container.querySelector<HTMLInputElement>('[data-search-box]');
  if (input === null) throw new Error('search box not rendered');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, CONTENT_SEARCH_DEBOUNCE_MS + 20));
  });
}

async function waitForText(container: HTMLDivElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await settle();
  }
  throw new Error(`"${text}" never rendered`);
}

describe('Sidebar thread-link titles', () => {
  it('projects cached names in recent and earlier groups and reacts to renames', async () => {
    const linked = { ...session('session_reference'), title: '被引用线程的完整名称' };
    const recent = { ...session('recent'), title: `Review /s/${linked.id} now` };
    const earlier = { ...session('earlier'), title: `Compare kiki://s/${linked.id} next` };
    const { container, root, queryClient } = await mount({
      sessions: [recent, earlier],
      sessionGroups: [
        { key: 'today', label: 'Today', items: [recent] },
        { key: 'earlier', label: 'Earlier', items: [earlier] },
      ],
    }, browserHost, [linked]);
    const recentRow = container.querySelector('[data-session-row="recent"]');
    const earlierRow = container.querySelector('[data-session-row="earlier"]');
    expect(recentRow?.textContent).toContain('Review 被引用线程的完整… now');
    expect(earlierRow?.textContent).toContain('Compare 被引用线程的完整… next');
    expect(recentRow?.innerHTML).not.toContain('/s/session_');
    expect(earlierRow?.innerHTML).not.toContain('kiki://');
    expect(getSession).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(['sessions', 'cached'], { items: [{ ...linked, title: 'Updated name' }] });
    });
    expect(recentRow?.textContent).toContain('Review Updated … now');
    await act(async () => { root.unmount(); });
  });

  it('fetches an uncached reference once and replaces the short-id placeholder', async () => {
    const linked = { ...session('session_remote_thread'), title: 'Referenced thread' };
    getSession.mockResolvedValue(linked);
    const owner = { ...session('owner'), title: `Review /s/${linked.id}` };
    const { container, root } = await mount({
      sessions: [owner], sessionGroups: [{ key: 'earlier', label: 'Earlier', items: [owner] }],
    });
    await waitForText(container, 'Review Referenc…');
    expect(getSession).toHaveBeenCalledExactlyOnceWith(linked.id);
    await act(async () => { root.unmount(); });
  });

  it('uses existing short ids for failed and untitled references, including last-prompt titles', async () => {
    const missing = { ...session('missing'), title: 'Check /s/session_abcdefghijk and kiki://s/session_untitled' };
    const prompt = { ...session('prompt'), title: '', last_prompt: 'Read /s/session_abcdefghijk again' };
    const blank = { ...session('session_untitled'), title: ' ' };
    const { container, root } = await mount({
      sessions: [missing, prompt],
      sessionGroups: [{ key: 'earlier', label: 'Earlier', items: [missing, prompt] }],
    }, browserHost, [blank]);
    await settle();
    expect(container.querySelector('[data-session-row="missing"]')?.textContent).toContain('Check abcdefgh and untitled');
    expect(container.querySelector('[data-session-row="prompt"]')?.textContent).toContain('Read abcdefgh again');
    expect(container.innerHTML).not.toContain('/s/session_');
    expect(container.innerHTML).not.toContain('kiki://');
    expect(getSession).toHaveBeenCalledExactlyOnceWith('session_abcdefghijk');
    await act(async () => { root.unmount(); });
  });

  it('searches and highlights the projected title while content results use the same labels', async () => {
    const linked = { ...session('session_reference'), title: 'Referenced thread' };
    const owner = { ...session('owner'), title: 'Review /s/session_reference now' };
    searchMessages.mockResolvedValue(page([hit({ session_id: owner.id, session_title: owner.title, snippet: 'match' })], false));
    const { container, root } = await mount({ sessions: [owner] }, browserHost, [linked]);
    await typeQuery(container, 'Referenc');
    await waitForText(container, 'match');
    const local = container.querySelector('[data-search-result="s:owner"]');
    expect(local?.textContent).toContain('Review Referenc… now');
    expect(local?.querySelector('mark')?.textContent).toBe('Referenc');
    expect(container.querySelector('[data-search-result="h:0"]')?.textContent).toContain('Review Referenc… now');
    expect(container.innerHTML).not.toContain('/s/session_');
    await act(async () => { root.unmount(); });
  });
});

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

    expect(container.querySelector('[data-search-incomplete]')?.textContent).toBe('Partial results — the search hit its time limit.');
  });
});

describe('Sidebar header controls', () => {
  it('keeps search and activity as two icons, with the field behind the search one', async () => {
    const { container } = await mount();
    // No standing search field: that vertical space belongs to the list.
    expect(container.querySelector('[data-search-box]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('[data-search-toggle]');
    expect(toggle?.getAttribute('aria-label')).toBe('Search sessions');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle?.click(); });
    expect(container.querySelector('[data-search-box]')).not.toBeNull();
    // Closing it again clears the query so the list is never silently filtered.
    await act(async () => { toggle?.click(); });
    expect(container.querySelector('[data-search-box]')).toBeNull();
  });

  it('badges the activity entry only while something is waiting', async () => {
    const quiet = await mount();
    const bell = quiet.container.querySelector<HTMLButtonElement>('[data-nav-activity]');
    expect(bell?.getAttribute('aria-label')).toBe('Activity');
    expect(quiet.container.querySelector('[data-activity-badge]')).toBeNull();

    const blocked = { ...session('s-blocked'), pending_interaction: 'approval' as const, last_seq: 4 };
    const { container } = await mount({
      sessions: [blocked],
      sessionGroups: [{ key: 'today', label: 'Today', items: [blocked] }],
    });
    expect(container.querySelector('[data-activity-badge]')?.textContent).toBe('1');
    expect(container.querySelector('[data-activity-badge]')?.getAttribute('data-activity-badge-tone')).toBe('needs-you');
    expect(container.querySelector('[data-nav-activity]')?.getAttribute('aria-label'))
      .toBe('1 item needs you');
  });

  it('counts finished-unread runs on the badge in the quieter tone', async () => {
    const done = { ...session('s-done'), last_turn_reason: 'completed' as const, last_seq: 6 };
    const failed = { ...session('s-failed'), last_turn_reason: 'failed' as const, last_seq: 3 };
    const { container } = await mount({
      sessions: [done, failed],
      sessionGroups: [{ key: 'today', label: 'Today', items: [done, failed] }],
    });
    const badge = container.querySelector('[data-activity-badge]');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('data-activity-badge-tone')).toBe('unread');
    expect(container.querySelector('[data-nav-activity]')?.getAttribute('aria-label'))
      .toBe('2 new items in Activity');
  });
});

describe('Sidebar session row states', () => {
  it('separates blocked, running, unread and caught-up rows', async () => {
    resetSessionSeen();
    const blocked = { ...session('s-blocked'), pending_interaction: 'question' as const, last_seq: 4 };
    const running = { ...session('s-running'), busy: true, last_seq: 4 };
    const unread = { ...session('s-unread'), last_seq: 4 };
    const caughtUp = { ...session('s-read'), last_seq: 4 };
    markSessionSeen('s-read', 4);
    const items = [blocked, running, unread, caughtUp];
    const { container } = await mount({
      sessions: items,
      sessionGroups: [{ key: 'today', label: 'Today', items }],
    });
    const stateOf = (id: string) =>
      container.querySelector(`[data-session-row="${id}"]`)?.getAttribute('data-session-row-state');
    expect(stateOf('s-blocked')).toBe('needs-me');
    expect(stateOf('s-running')).toBe('running');
    expect(stateOf('s-unread')).toBe('unread');
    expect(stateOf('s-read')).toBe('read');
    // Each state carries its own marker; only the caught-up row has none.
    const markOf = (id: string) =>
      container.querySelector(`[data-session-row="${id}"] [data-session-status]`)?.getAttribute('data-session-status');
    expect(markOf('s-unread')).toBe('unread');
    expect(markOf('s-read')).toBe('idle');
    // Blocking beats running on the same row.
    const both = { ...session('s-both'), busy: true, pending_interaction: 'approval' as const, last_seq: 4 };
    const mixed = await mount({
      sessions: [both],
      sessionGroups: [{ key: 'today', label: 'Today', items: [both] }],
    });
    expect(mixed.container.querySelector('[data-session-row="s-both"]')?.getAttribute('data-session-row-state'))
      .toBe('needs-me');
  });
});

describe('Sidebar background tasks', () => {
  it('marks running background tasks with a terminal glyph and a list, not a "+N" chip', async () => {
    listTasks.mockResolvedValue({ items: [
      { id: 't1', session_id: 's-run', kind: 'bash', description: 'live viewer', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 't2', session_id: 's-run', kind: 'bash', description: 'rerun the suite', status: 'running', created_at: '2026-01-01T00:01:00.000Z' },
    ] });
    listPrompts.mockResolvedValue({ active: null, queued: [] });
    const running = { ...session('s-run'), busy: true, main_turn_active: false };
    const { container } = await mount({ sessions: [running], sessionGroups: [{ key: 'today', label: 'Today', items: [running] }] });
    for (let index = 0; index < 4; index += 1) await settle();
    const mark = container.querySelector<HTMLElement>('[data-session-row="s-run"] [data-session-background-tasks]');
    expect(mark?.getAttribute('data-session-background-tasks')).toBe('2');
    expect(mark?.querySelector('svg[data-icon="terminal"]')).not.toBeNull();
    expect(mark?.title).toBe(['2 background tasks running', '· live viewer', '· rerun the suite'].join('\n'));
    expect(mark?.textContent).toContain('2 background tasks running');
    expect(container.querySelector('[data-session-row="s-run"]')?.textContent).not.toContain('+2');
  });
});

describe('Sidebar temporary conversations', () => {
  it('lists them in their own block above the history, without row actions', async () => {
    const saved = session('s-saved');
    listEphemeralSessions.mockResolvedValue({ items: [{ ...session('s-temp'), ephemeral: true }] });
    const { container } = await mount({
      sessions: [saved],
      sessionGroups: [{ key: 'today', label: 'Today', items: [saved] }],
    });
    await settle();
    const block = container.querySelector('[data-session-group-block="ephemeral"]');
    expect(block?.getAttribute('aria-label')).toBe('Temporary');
    expect(block?.querySelector('[data-session-row="s-temp"]')).not.toBeNull();
    expect(block?.querySelector('[data-session-pin-toggle]')).toBeNull();
    // It opens the block list, and never joins the paged groups.
    const blocks = [...container.querySelectorAll('[data-session-group-block]')].map((node) => node.getAttribute('data-session-group-block'));
    expect(blocks).toEqual(['ephemeral', 'today']);
  });

  it('uses paged temporary-session cache data beyond the first 50 without losing row order', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({ ...session(`temporary-${index}`), ephemeral: true }));
    const { container, queryClient } = await mount();
    await settle();
    await act(async () => {
      queryClient.setQueryData(['sessions', 'ephemeral'], { pages: [{ items: rows.slice(0, 50), has_more: true, next_cursor: rows[49]!.id }, { items: rows.slice(50), has_more: false }], pageParams: [undefined, rows[49]!.id] });
    });
    await settle();
    const ids = [...container.querySelectorAll('[data-session-ephemeral] [data-session-row]')].map((node) => node.getAttribute('data-session-row'));
    expect(ids).toEqual(rows.map((row) => row.id));
    expect(listEphemeralSessions).toHaveBeenCalledWith({ before_id: undefined, page_size: 50 });
  });

  it('reads the next page of temporary conversations on request, and reports a refusal', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...session(`temporary-${index}`), ephemeral: true }));
    const older = { ...session('temporary-50'), ephemeral: true };
    listEphemeralSessions.mockResolvedValue({ items: first, has_more: true, next_cursor: first[49]!.id });
    const { container } = await mount();
    await settle();
    const more = container.querySelector<HTMLButtonElement>('[data-session-ephemeral-load-more]');
    expect(more).not.toBeNull();
    expect(container.querySelector('[data-session-ephemeral-load-error]')).toBeNull();
    expect(container.querySelectorAll('[data-session-ephemeral]')).toHaveLength(50);

    // The next page is one request, and its rows join the same block in order.
    listEphemeralSessions.mockResolvedValue({ items: [older], has_more: false });
    await act(async () => { more?.click(); });
    await settle();
    expect(listEphemeralSessions).toHaveBeenLastCalledWith({ before_id: first[49]!.id, page_size: 50 });
    const ids = [...container.querySelectorAll('[data-session-ephemeral] [data-session-row]')].map((node) => node.getAttribute('data-session-row'));
    expect(ids.at(-1)).toBe('temporary-50');
    // Nothing left to read, so the row retires with the page.
    expect(container.querySelector('[data-session-ephemeral-load-more]')).toBeNull();

    // A refused page keeps the rows it already has and says so, so the reader
    // can press the same button again.
    listEphemeralSessions.mockResolvedValue({ items: first, has_more: true, next_cursor: first[49]!.id });
    const refused = await mount();
    await settle();
    listEphemeralSessions.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { refused.container.querySelector<HTMLButtonElement>('[data-session-ephemeral-load-more]')?.click(); });
    await settle();
    expect(refused.container.querySelector('[data-session-ephemeral-load-error]')?.textContent).toBe('offline');
    expect(refused.container.querySelectorAll('[data-session-ephemeral]').length).toBeGreaterThan(0);
  });

  it('shows no block while there are none', async () => {
    const { container } = await mount();
    await settle();
    expect(container.querySelector('[data-session-group-block="ephemeral"]')).toBeNull();
  });
});

describe('Sidebar entry distribution', () => {
  it('lists the six tool pages in the primary nav, in order', async () => {
    const { container } = await mount();
    const nav = container.querySelector('[data-primary-nav]');
    expect(nav?.getAttribute('aria-label')).toBe('Workspace tools');
    const labels = [...(nav?.querySelectorAll('button') ?? [])].map((button) => button.children[1]?.textContent);
    expect(labels).toEqual(['Task board', 'Scheduled tasks', 'Memory', 'Personas', 'Usage', 'Capabilities']);
    expect(nav?.querySelector('[data-nav-personas]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-usage]')).not.toBeNull();
    await settle();
    expect(nav?.querySelector('[data-request-governance-badge]')?.textContent).toBe('3 · +2');
    expect(nav?.querySelector('[data-nav-board]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-cron]')).not.toBeNull();
    // Memory is permanent, on or off: switched off the page is the turn-on guide.
    expect(nav?.querySelector('[data-nav-memory]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-capabilities]')).not.toBeNull();
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

describe('Sidebar semantic structure', () => {
  it('names the landmark, labels each group, and marks the active session', async () => {
    const active = session('active');
    const other = session('other');
    const groups: SessionGroup[] = [
      { key: 'today', label: 'Today', items: [active, other] },
      { key: 'week', label: 'Past 7 days', items: [session('older')] },
    ];
    const { container } = await mount({
      activeSessionId: 'active',
      sessions: [active, other, ...groups[1]!.items],
      sessionGroups: groups,
    });

    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('aria-label')).toBe('Session navigation');

    // Region is a landmark whose accessible name is computed from aria-label;
    // querying role + name together (the no-testing-library getByRole
    // equivalent) proves the name actually reaches the a11y tree — a bare
    // aria-label on a generic div would be dropped from the name computation.
    const regions = container.querySelectorAll<HTMLElement>('[role="region"][aria-label]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('aria-label')).toBe('Session list');
    expect(regions[0]?.hasAttribute('data-session-list')).toBe(true);

    const labelledGroups = [
      // Scoped to the session list: the persona group is a group of its own,
      // above the list, and its presence must not read as a broken time group.
      ...regions[0]!.querySelectorAll<HTMLElement>('[role="group"][aria-label]'),
    ].map((node) => node.getAttribute('aria-label'));
    expect(labelledGroups).toEqual(['Today', 'Past 7 days']);

    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-session-title]')].map(
      (title) => title.closest('button'),
    );
    const activeRow = rows.find(
      (row) => row?.textContent?.includes('active') === true,
    );
    const otherRow = rows.find((row) => row?.textContent?.includes('other') === true);
    expect(activeRow?.getAttribute('aria-current')).toBe('page');
    expect(otherRow?.getAttribute('aria-current')).toBeNull();
  });

  it('adds the persona group above the session list without disturbing its time groups', async () => {
    listPersonas.mockResolvedValue([{ id: 'lin-lan', name: '小岚', revision: 'revision-1', archived: false, homeSessionId: 'home_lin' }]);
    const active = session('active');
    const { container } = await mount({
      activeSessionId: 'active',
      sessions: [active],
      workspaceOptions: [{ id: 'ws_a', name: 'EasyAgent', root: '/a', created_at: '', last_opened_at: '', pinned: false, session_count: 0, isGit: false }],
      sessionGroups: [{ key: 'today', label: 'Today', items: [active] }],
    });
    await settle();

    const personaGroup = container.querySelector<HTMLElement>('[data-sidebar-personas] [role="group"]');
    expect(personaGroup?.getAttribute('aria-label')).toBe('Personas');
    expect(personaGroup?.querySelector('[data-sidebar-persona-row="lin-lan"]')).not.toBeNull();
    // The name is the persona's stable daily address, never a fixed session.
    const name = personaGroup!.querySelector<HTMLButtonElement>('[data-sidebar-persona-row="lin-lan"] button')!;
    expect(name.textContent).toContain('小岚');

    const sessionList = container.querySelector<HTMLElement>('[data-session-list]')!;
    expect([...sessionList.querySelectorAll<HTMLElement>('[role="group"][aria-label]')].map((node) => node.getAttribute('aria-label')))
      .toEqual(['Today']);
    // Not inside the session list region.
    expect(sessionList.querySelector('[data-sidebar-personas]')).toBeNull();
  });

  it('replaces the list with a labelled listbox the search box drives with ↑↓ / Enter', async () => {
    searchMessages.mockResolvedValue(page([A1, A2], false));
    const local = { ...session('alpha-local'), title: 'alpha notes' };
    const { container } = await mount({
      sessions: [local],
      sessionGroups: [{ key: 'today', label: 'Today', items: [local] }],
    });
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');

    const listbox = container.querySelector<HTMLElement>('[role="listbox"][data-search-results]');
    expect(listbox?.getAttribute('aria-label')).toBe('Search sessions');
    expect(container.querySelector('[data-session-list]')).toBeNull();
    // Groups in reading order: local sessions first, then server messages.
    const groups = [...(listbox?.querySelectorAll('[role="group"]') ?? [])].map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Sessions', 'Messages']);
    const input = container.querySelector<HTMLInputElement>('[data-search-box]')!;
    expect(input.getAttribute('aria-activedescendant')).toBe('sidebar-result-s:alpha-local');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(input.getAttribute('aria-activedescendant')).toBe('sidebar-result-h:0');
    // The matched term is highlighted inside the snippet.
    expect(listbox?.querySelector('[data-search-result="h:0"] mark')?.textContent).toBe('alpha');
  });

  it('renders a retry button when initial search fails and allows refetching', async () => {
    searchMessages.mockRejectedValueOnce(new Error('Network offline'));
    const { container } = await mount();
    await typeQuery(container, 'beta');
    await waitForText(container, 'Search failed');

    const retryBtn = container.querySelector<HTMLButtonElement>('[data-search-initial-retry]');
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe('Retry');

    searchMessages.mockResolvedValueOnce(page([hit({ session_id: 's2', snippet: 'beta result' })], false));
    await act(async () => {
      retryBtn?.click();
    });
    await waitForText(container, 'beta result');
  });

  it('shows a specific indexer reason and clears backoff before refetching', async () => {
    searchMessages.mockResolvedValueOnce(page([], false, undefined, { index_state: {
      state: 'unavailable', reason: 'indexer_backoff', indexed_sessions: 0, total_sessions: 2, documents: 0,
    } }));
    const { container } = await mount();
    await typeQuery(container, 'needle');
    await waitForText(container, 'backing off');
    searchMessages.mockResolvedValueOnce(page([hit({ session_id: 's2', snippet: 'needle found' })], false));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-search-unavailable-retry]')?.click();
    });
    expect(retrySearchIndexer).toHaveBeenCalledTimes(1);
    await waitForText(container, 'needle found');
  });
});

describe('Sidebar view menu', () => {
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return {
      sessions: [one],
      sessionGroups: [{ key: 'today', label: 'Today', items: [one] }],
    };
  };

  it('keeps arrangement (group + sort) apart from filtering', async () => {
    const { container } = await mount(listed());
    const view = await openViewMenu(container);
    expect(view.querySelectorAll('[data-group-by]')).toHaveLength(3);
    expect([...view.querySelectorAll('[data-sort-by]')].map((node) => node.getAttribute('data-sort-by')))
      .toEqual(['updated-desc', 'created-desc', 'title']);
    // Nothing in the View menu hides a session.
    expect(view.querySelector('[data-workspace-filter], [data-status-filter], [data-archived-filter]')).toBeNull();
  });

  it('reports the current selection and writes grouping and sorting through', async () => {
    const onGroupBy = vi.fn();
    const onSortBy = vi.fn();
    const { container } = await mount({ ...listed(), groupBy: 'time', sortBy: 'updated-desc', onGroupBy, onSortBy });
    const menu = await openViewMenu(container);
    expect(menu.querySelector('[data-group-by="time"]')?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-sort-by="updated-desc"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-group-by="none"]')?.click();
      menu.querySelector<HTMLButtonElement>('[data-sort-by="created-desc"]')?.click();
    });
    expect(onGroupBy).toHaveBeenCalledWith('none');
    expect(onSortBy).toHaveBeenCalledWith('created-desc');
    // Preferences do not dismiss the panel; the list rearranges behind it.
    expect(container.querySelector('[data-view-menu]')).not.toBeNull();
  });

  it('collapses a workspace group and previews at most eight sessions before "Show N more"', async () => {
    const many = Array.from({ length: 11 }, (_, index) => session(`w${index}`));
    const { container } = await mount({
      sessions: many,
      groupBy: 'workspace',
      sessionGroups: [{ key: 'ws_test', label: 'workshop', items: many }],
    });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(8);
    const more = container.querySelector<HTMLButtonElement>('[data-session-group-more="ws_test"]');
    expect(more?.textContent).toBe('Show 3 more');
    await act(async () => { more?.click(); });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(11);
    const header = container.querySelector<HTMLButtonElement>('[data-session-group="ws_test"]');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { header?.click(); });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(0);
  });
});

describe('Sidebar filters', () => {
  const wsA = workspace('wd_a_000000000000', 'workshop', true);
  const wsB = workspace('wd_b_000000000000', 'another-ws');
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return { sessions: [one], sessionGroups: [{ key: 'today', label: 'Today', items: [one] }] };
  };

  it('leaves no select element anywhere in the sidebar', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await openFilterMenu(container);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('composes status, workspaces (multi-select) and archived through one callback', async () => {
    const onFiltersChange = vi.fn();
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB], onFiltersChange });
    const menu = await openFilterMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-status-filter="running"]')?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: ['running'], workspaces: [], archived: 'hide' });
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-workspace-filter="${wsB.id}"]`)?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], workspaces: [wsB.id], archived: 'hide' });
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-archived-filter="only"]')?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], workspaces: [], archived: 'only' });
    expect(menu.querySelector('[data-manage-workspaces]')).not.toBeNull();
  });

  it('adds a second workspace instead of replacing the first', async () => {
    const onFiltersChange = vi.fn();
    const { container } = await mount({
      ...listed(),
      workspaceOptions: [wsA, wsB],
      filters: { status: [], workspaces: [wsA.id], archived: 'hide' },
      onFiltersChange,
    });
    const menu = await openFilterMenu(container);
    expect(menu.querySelector(`[data-workspace-filter="${wsA.id}"]`)?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-workspace-filter="${wsB.id}"]`)?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], workspaces: [wsA.id, wsB.id], archived: 'hide' });
  });

  it('carries the per-row workspace pin toggle into the filter menu', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
    const menu = await openFilterMenu(container);
    const pins = [...menu.querySelectorAll<HTMLButtonElement>('[data-workspace-pin-toggle]')];
    expect(pins).toHaveLength(2);
    expect(pins[0]?.getAttribute('aria-label')).toBe('Unpin the workspace workshop');
    expect(pins[1]?.getAttribute('aria-label')).toBe('Pin the workspace another-ws to the top');
    await act(async () => { pins[1]?.click(); });
    expect(setWorkspacePinned).toHaveBeenCalledWith(wsB.id, true);
  });

  it('hides the workspace section when the server reports none', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [] });
    const menu = await openFilterMenu(container);
    expect(menu.querySelector('[data-workspace-filter]')).toBeNull();
    expect(menu.querySelector('[data-status-filter="running"]')).not.toBeNull();
  });

  it('renders no chip row while every filter sits at its default', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA] });
    expect(container.querySelector('[data-sidebar-filters]')).toBeNull();
  });

  it('shows one removable chip per active filter and clears each on its own', async () => {
    const onFiltersChange = vi.fn();
    const filters = { status: ['needs-me'] as const, workspaces: [wsA.id], archived: 'include' as const };
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA], filters: { ...filters, status: [...filters.status] }, onFiltersChange });
    const chips = [...container.querySelectorAll<HTMLElement>('[data-sidebar-filter-chip]')].map((chip) => chip.textContent);
    // The clear control is an icon; its name lives in the aria-label.
    expect(chips).toEqual(['Needs me', 'workshop', 'Including archived']);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sidebar-filter-clear="ws"]')?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: ['needs-me'], workspaces: [], archived: 'include' });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sidebar-filters-clear-all]')?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], workspaces: [], archived: 'hide' });
  });

  it('keeps the chips visible while a search runs, and scopes the content search to one workspace', async () => {
    searchMessages.mockResolvedValue(page([{ ...A1, workspace_id: wsA.id }], false));
    const { container } = await mount({
      ...listed(),
      workspaceOptions: [wsA],
      filters: { status: [], workspaces: [wsA.id], archived: 'hide' },
    });
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');
    expect(container.querySelector('[data-sidebar-filters]')).not.toBeNull();
    expect(container.querySelector('[data-search-scope]')).not.toBeNull();
    expect(searchMessages.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'alpha', workspace_id: wsA.id });
  });

  it('offers to clear filters (not show archived) when the filters leave nothing', async () => {
    const { container } = await mount({
      sessions: [session('one')],
      sessionGroups: [],
      filters: { status: ['running'], workspaces: [], archived: 'hide' },
    });
    const empty = container.querySelector('[data-sidebar-empty]');
    expect(empty?.textContent).toContain('No sessions match these filters.');
    expect(empty?.textContent).toContain('Clear filters');
  });

  it('keeps exactly one archived entry on the unfiltered empty state', async () => {
    const onFiltersChange = vi.fn();
    const { container } = await mount({ sessions: [], sessionGroups: [], onFiltersChange });
    const entries = [...container.querySelectorAll('button')].filter((element) =>
      (element.textContent ?? '').includes('archived'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.closest('[data-sidebar-empty]')).not.toBeNull();
    await act(async () => { (entries[0] as HTMLButtonElement).click(); });
    expect(onFiltersChange).toHaveBeenCalledWith({ status: [], workspaces: [], archived: 'include' });
  });
});

describe('Sidebar session menu location & link group', () => {
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return { sessions: [one], sessionGroups: [{ key: 'today', label: 'Today', items: [one] }] };
  };
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  async function openSessionMenu(container: HTMLDivElement): Promise<HTMLElement> {
    const row = container.querySelector('[data-session-title]');
    if (row === null) throw new Error('session row not rendered');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const menu = container.querySelector<HTMLElement>('[data-session-menu]');
    if (menu === null) throw new Error('session menu did not open');
    return menu;
  }

  it('offers one room entry and joins an existing room through the member API', async () => {
    const room = { id: 'example-room', name: 'Project room', members: [] } as unknown as RoomDocument;
    roomRest.list.mockResolvedValue([room]);
    roomRest.get.mockResolvedValue(room);
    roomRest.addMember.mockResolvedValue({ ...room, members: [{ kind: 'thread', sessionId: 'one' }] });
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="new-thread-room"]')).toBeNull();
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="join-room"]')!.click(); });
    await settle();
    expect(document.querySelector('[data-join-room-new]')?.textContent).toBe('New room…');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-join-room="example-room"]')!.click(); });
    await settle();
    expect(roomRest.addMember).toHaveBeenCalledWith('example-room', { kind: 'thread', sessionId: 'one' });
    expect(document.querySelector('[data-join-room-dialog]')).toBeNull();
  });

  it('keeps multi-selected threads through the empty-room chooser into real room creation', async () => {
    roomRest.list.mockResolvedValue([]);
    roomRest.searchThreads.mockResolvedValue({ items: [], has_more: false });
    roomRest.createFromThreads.mockResolvedValue({ id: 'new-example-room', name: 'New room' });
    const threads = [session('one'), session('two')];
    const { container } = await mount({ sessions: threads, sessionGroups: [{ key: 'today', label: 'Today', items: threads }] });
    await act(async () => {
      for (const id of ['one', 'two']) container.querySelector<HTMLButtonElement>(`[data-session-row="${id}"] > button`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    const menu = await openSessionMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="join-room"]')!.click(); });
    await settle();
    expect(document.querySelector('[data-join-room-dialog]')?.textContent).toContain('Add 2 threads');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-join-room-new]')!.click(); });
    expect(document.querySelectorAll('[data-new-thread-room-member]')).toHaveLength(2);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-new-thread-room-submit]')!.click(); });
    await settle();
    expect(roomRest.createFromThreads).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['one', 'two'] }));
  });

  it('copies the in-app route and the session cwd from the new group', async () => {
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="copy-link"]')?.textContent).toBe('Copy thread link');
    expect(menu.querySelector('[data-menu-item="copy-path"]')?.textContent).toBe('Copy working directory');
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-menu-item="copy-link"]')?.click();
    });
    expect(writeText).toHaveBeenCalledWith('/s/one');
    // The menu closes after a copy action.
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    const again = await openSessionMenu(container);
    await act(async () => {
      again.querySelector<HTMLButtonElement>('[data-menu-item="copy-path"]')?.click();
    });
    expect(writeText).toHaveBeenCalledWith('C:/tmp');
  });

  it('hides the desktop opener entries in the browser runtime', async () => {
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="open-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
  });

  it('shows host path actions for a local scope with native openers', async () => {
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => {});
    const { container } = await mount(listed(), { ...browserHost, revealPath, openPath });
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="open-folder"]')?.textContent).toBe('Open working directory');
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="open-folder"]')!.click(); });
    expect(revealPath).toHaveBeenCalledWith('C:/tmp');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('hides host path actions for SSH even when native openers exist, while keeping copy actions', async () => {
    connectionScope.id = 'ssh:host-1';
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => {});
    const remote = { ...session('one'), metadata: { cwd: '/home/dev/project' } };
    const { container } = await mount({
      sessions: [remote],
      sessionGroups: [{ key: 'today', label: 'Today', items: [remote] }],
    }, { ...browserHost, revealPath, openPath });
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="copy-link"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="copy-path"]')).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="open-folder"]')).toBeNull();
    expect(menu.querySelector('[data-menu-item="open-default-app"]')).toBeNull();
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="copy-path"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('/home/dev/project');
    expect(revealPath).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('adds the thread link to the open conversation, and disables itself with none open', async () => {
    const other = session('session_other');
    const current = session('session_current');
    const items = [other, current];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }], activeSessionId: 'session_current' });
    const inserted: string[] = [];
    const unsubscribe = subscribeComposerInserts('session_current', (text) => { inserted.push(text); return true; });
    try {
      const row = container.querySelector('[data-session-row="session_other"] [data-session-title]')!;
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
      const entry = container.querySelector<HTMLButtonElement>('[data-session-menu] [data-menu-item="add-to-conversation"]')!;
      expect(entry.textContent).toBe('Add to conversation');
      expect(entry.disabled).toBe(false);
      await act(async () => { entry.click(); });
      expect(inserted).toEqual(['/s/session_other']);
      expect(container.querySelector('[data-session-menu]')).toBeNull();
      // The open conversation's own row has nothing to add to.
      const self = container.querySelector('[data-session-row="session_current"] [data-session-title]')!;
      await act(async () => { self.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
      expect(container.querySelector<HTMLButtonElement>('[data-menu-item="add-to-conversation"]')?.disabled).toBe(true);
    } finally {
      unsubscribe();
    }
    const none = await mount(listed());
    const menu = await openSessionMenu(none.container);
    const disabled = menu.querySelector<HTMLButtonElement>('[data-menu-item="add-to-conversation"]')!;
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toBe('Open a conversation to add this thread to it');
  });

  it('keeps the link entries below the action group and above pin/rename', async () => {
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map(
      (element) => element.textContent,
    );
    expect(labels.indexOf('Copy link')).toBeGreaterThan(labels.indexOf('Undo last turn…'));
    expect(labels.indexOf('Copy link')).toBeLessThan(labels.indexOf('Pin to top'));
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

describe('session thread relations', () => {
  const related = (id: string, metadata: Record<string, unknown>): Session => ({
    ...session(id),
    metadata: { cwd: 'C:/tmp', ...metadata } as Session['metadata'],
  });
  const thread = (id: string, parentId: string) =>
    related(id, { created_by_session_id: parentId, created_by_agent_id: 'main' });
  const branch = (id: string, parentId: string) =>
    related(id, { parent_session_id: parentId, child_session_kind: 'child' });
  const group = (key: string, items: Session[]) => ({ key, label: key, items });

  it('reads both relation shapes and ignores unrelated sessions', () => {
    expect(sessionRelationOf(session('plain'))).toBeUndefined();
    expect(sessionRelationOf(thread('t', 'root'))).toEqual({ kind: 'thread', parentId: 'root', agentId: 'main' });
    expect(sessionRelationOf(branch('b', 'root'))).toEqual({ kind: 'branch', parentId: 'root' });
    // A session pointing at itself is not a relation.
    expect(sessionRelationOf(thread('self', 'self'))).toBeUndefined();
    // parent_session_id without the child kind is a fork lineage, not a nesting.
    expect(sessionRelationOf(related('f', { parent_session_id: 'root' }))).toBeUndefined();
  });

  it('nests threads and branches under their creator, one level deep', () => {
    const root = session('root');
    const nested = nestSessionThreads(
      [group('all', [root, thread('t1', 'root'), branch('b1', 'root'), thread('t2', 't1')])],
      { crossGroups: true },
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]!.nodes.map((node) => node.session.id)).toEqual(['root']);
    // Deeper descendants flatten onto the visible root instead of indenting twice.
    expect(nested[0]!.nodes[0]!.children.map((node) => node.session.id)).toEqual(['t1', 'b1', 't2']);
    expect(nested[0]!.total).toBe(4);
  });

  it('keeps a row top-level when its creator is not loaded', () => {
    const nested = nestSessionThreads([group('all', [thread('orphan', 'missing')])], { crossGroups: true });
    expect(nested[0]!.nodes.map((node) => node.session.id)).toEqual(['orphan']);
    // The relation still travels, so the row can name where it came from.
    expect(nested[0]!.nodes[0]!.relation?.parentId).toBe('missing');
  });

  it('nests across time buckets but never across workspace buckets', () => {
    const groups = [group('today', [session('root')]), group('week', [thread('t1', 'root')])];
    const crossing = nestSessionThreads(groups, { crossGroups: true });
    expect(crossing).toHaveLength(1);
    expect(crossing[0]!.nodes[0]!.children.map((node) => node.session.id)).toEqual(['t1']);
    const contained = nestSessionThreads(groups, { crossGroups: false });
    expect(contained.map((entry) => entry.key)).toEqual(['today', 'week']);
    expect(contained[1]!.nodes.map((node) => node.session.id)).toEqual(['t1']);
  });

  it('leaves a pinned thread in the pinned bucket', () => {
    const pinnedThread = {
      ...thread('t1', 'root'),
      metadata: { cwd: 'C:/tmp', created_by_session_id: 'root', [SESSION_PIN_META_KEY]: true } as Session['metadata'],
    };
    const nested = nestSessionThreads(
      [group('pinned', [pinnedThread]), group('today', [session('root')])],
      { crossGroups: true },
    );
    expect(nested.map((entry) => entry.key)).toEqual(['pinned', 'today']);
    expect(nested[0]!.nodes.map((node) => node.session.id)).toEqual(['t1']);
    expect(nested[1]!.nodes[0]!.children).toHaveLength(0);
  });

  it('survives a metadata cycle without losing a row', () => {
    const nested = nestSessionThreads(
      [group('all', [thread('a', 'b'), thread('b', 'a')])],
      { crossGroups: true },
    );
    const ids = nested.flatMap((entry) => entry.nodes.flatMap((node) => [node.session.id, ...node.children.map((child) => child.session.id)]));
    expect(ids.toSorted()).toEqual(['a', 'b']);
  });

  it('toggles thread display through its menu, persists it, and preserves creator metadata', async () => {
    const child = thread('t1', 'root');
    const items = [session('root'), child];
    const props = { sessions: items, sessionGroups: [group('today', items)] };
    const first = await mount(props);
    const openMenu = async (container: HTMLDivElement) => {
      await act(async () => { container.querySelector('[data-session-row="t1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    };
    await openMenu(first.container);
    const promote = first.container.querySelector<HTMLButtonElement>('[data-menu-item="thread-display"]')!;
    expect(promote.textContent).toBe('Show at top level');
    await act(async () => { promote.click(); });
    expect(first.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).toBeNull();
    expect(first.container.querySelector('[data-session-row="t1"] [data-session-relation-note]')?.textContent).toContain('root');
    expect(child.metadata['created_by_session_id']).toBe('root');
    expect(child.updated_at).toBe('2026-01-01T00:00:00.000Z');
    await act(async () => { first.root.unmount(); });
    const second = await mount(props);
    expect(second.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).toBeNull();
    await openMenu(second.container);
    const nest = second.container.querySelector<HTMLButtonElement>('[data-menu-item="thread-display"]')!;
    expect(nest.textContent).toBe('Show nested');
    await act(async () => { nest.click(); });
    expect(second.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).not.toBeNull();
    const third = await mount(props);
    expect(third.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).not.toBeNull();
  });

  it('does not offer a thread display toggle on ordinary or forked sessions', async () => {
    const items = [session('root'), branch('forked', 'root')];
    const { container } = await mount({ sessions: items, sessionGroups: [group('today', items)] });
    for (const id of ['root', 'forked']) {
      await act(async () => { container.querySelector(`[data-session-row="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
      expect(container.querySelector('[data-menu-item="thread-display"]')).toBeNull();
    }
  });

  it('renders children as single indented rows with no spine, fold bar or thread glyph', async () => {
    const root = session('root');
    const started = thread('t1', 'root');
    const forked = branch('b1', 'root');
    const items = [root, started, forked];
    const { container } = await mount({ sessions: items, sessionGroups: [group('today', items)] });
    const children = container.querySelector('[data-session-threads="root"]');
    expect(children?.querySelectorAll('[data-session-row]')).toHaveLength(2);
    expect(container.querySelector('[data-session-threads-toggle]')).toBeNull();
    // Only the fork carries a kind glyph; the started session is just indented.
    expect(container.querySelector('[data-session-row="t1"] [data-session-relation]')).toBeNull();
    expect(container.querySelector('[data-session-row="b1"] [data-session-relation="branch"]')).not.toBeNull();
    // Nested rows are one line: no second-line fact at all.
    expect(container.querySelector('[data-session-row="t1"] [data-session-location]')).toBeNull();
    // The relation lives in the accessible name, in two distinct phrasings.
    expect(container.querySelector('[data-session-row="t1"] button')?.getAttribute('aria-label'))
      .toBe('t1, started by root');
    expect(container.querySelector('[data-session-row="b1"] button')?.getAttribute('aria-label'))
      .toBe('b1, a branch of root');
  });

  it('keeps an orphan top-level and names who started it', async () => {
    const orphan = thread('orphan', 'missing');
    const { container } = await mount({ sessions: [orphan], sessionGroups: [group('today', [orphan])] });
    expect(container.querySelector('[data-session-row="orphan"] [data-session-relation-note="thread"]')?.textContent)
      .toBe('Started by another session');
  });
});

describe('Sidebar grouping', () => {
  it('uses one header rule, counts only workspace buckets, and drops the path inside them', async () => {
    const a = { ...session('a'), metadata: { cwd: 'C:/work/app' } as Session['metadata'] };
    const time = await mount({ sessions: [a], sessionGroups: [{ key: 'today', label: 'Today', items: [a] }] });
    expect(time.container.querySelector('[data-session-group="today"] [data-session-group-count]')).toBeNull();
    expect(time.container.querySelector('[data-session-row="a"] [data-session-location]')).not.toBeNull();

    const ws = await mount({
      sessions: [a],
      groupBy: 'workspace',
      sessionGroups: [{ key: 'ws_test', label: 'app', items: [a] }],
    });
    const header = ws.container.querySelector('[data-session-group="ws_test"]');
    // The count sits right after the label, inside the header, not in the row-actions column.
    expect(header?.querySelector('[data-session-group-count]')?.textContent).toBe('1');
    expect(ws.container.querySelector('[data-session-row="a"] [data-session-location]')).toBeNull();
  });

  it('shows the time at the end of the row and needs-you once, on the bell', async () => {
    const blocked = { ...session('blocked'), pending_interaction: 'approval' as const, last_seq: 3 };
    const { container } = await mount({ sessions: [blocked], sessionGroups: [{ key: 'today', label: 'Today', items: [blocked] }] });
    expect(container.querySelector('[data-session-row="blocked"] [data-session-time]')).not.toBeNull();
    expect(container.querySelector('[data-status-shortcut="needs-me"]')).toBeNull();
    expect(container.querySelector('[data-activity-badge]')).not.toBeNull();
    expect(container.querySelector('[data-session-row="blocked"] [data-session-needs-you]')?.textContent).toBe('Awaiting approval');
  });

  it('keeps row dots still and draws nothing for a caught-up row', async () => {
    resetSessionSeen();
    const running = { ...session('run'), busy: true, last_seq: 2 };
    const read = { ...session('read'), last_seq: 2 };
    markSessionSeen('read', 2);
    const items = [running, read];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    const runDot = container.querySelector('[data-session-row="run"] [data-life]');
    expect(runDot?.getAttribute('data-life')).toBe('working');
    expect(runDot?.hasAttribute('data-life-still')).toBe(true);
    expect(container.querySelector('[data-session-row="read"] [data-life]')).toBeNull();
    // The header's running count is the one mark allowed to breathe.
    expect(container.querySelector('[data-activity-summary] [data-life]')?.hasAttribute('data-life-still')).toBe(false);
  });

  it('says an unseen failure in words and marks it with a square, not only a colour', async () => {
    resetSessionSeen();
    const failed = { ...session('fail'), last_turn_reason: 'failed' as const, last_seq: 4 };
    const stopped = { ...session('stop'), last_turn_reason: 'cancelled' as const, last_seq: 4 };
    const items = [failed, stopped];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    expect(container.querySelector('[data-session-row="fail"] [data-session-failed]')?.textContent).toBe('Failed');
    expect(container.querySelector('[data-session-row="stop"] [data-session-failed]')?.textContent).toBe('Stopped');
    const mark = container.querySelector('[data-session-row="fail"] [data-life="failed"]');
    expect(mark?.className).toContain('rounded-[1.5px]!');
  });

  it('opens and focuses its search when another surface asks for the session list', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-search-box]')).toBeNull();
    await act(async () => {
      requestSessionSearch();
    });
    // The input mounts on the state change, then takes focus on the next tick.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const box = container.querySelector<HTMLInputElement>('[data-search-box]');
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('keeps a folded workspace honest: it still marks a session that needs you', async () => {
    const blocked = { ...session('blocked'), pending_interaction: 'approval' as const, last_seq: 3 };
    const { container } = await mount({
      sessions: [blocked],
      groupBy: 'workspace',
      sessionGroups: [{ key: 'ws_test', label: 'app', items: [blocked] }],
    });
    const header = container.querySelector<HTMLButtonElement>('[data-session-group="ws_test"]')!;
    expect(header.querySelector('[data-session-group-life]')).toBeNull();
    await act(async () => { header.click(); });
    expect(header.querySelector('[data-session-group-life]')?.getAttribute('data-session-group-life')).toBe('waiting');
  });

  it('counts a nav badge as plain accent-ink text, with no filled chip', async () => {
    const { container } = await mount({ navBadges: { cron: { count: 2, label: '2 stale' } } });
    const badge = container.querySelector('[data-nav-badge="cron"]');
    expect(badge?.className).toContain('text-accent-ink');
    expect(badge?.className).not.toContain('bg-accent-soft');
  });
});

describe('Sidebar workspace groups', () => {
  const wsA = workspace('ws_a', 'alpha', true);
  const wsB = workspace('ws_b', 'beta');
  const inA = { ...session('a1'), workspace_id: 'ws_a' };
  const inB = { ...session('b1'), workspace_id: 'ws_b' };
  const grouped = (): SidebarOverrides => ({
    sessions: [inA, inB],
    groupBy: 'workspace',
    workspaceOptions: [wsA, wsB],
    sessionGroups: [
      { key: 'ws_a', label: 'alpha', items: [inA] },
      { key: 'ws_b', label: 'beta', items: [inB] },
    ],
  });

  it('marks the workspace of the open session, and only that one', async () => {
    const { container } = await mount({ ...grouped(), activeSessionId: 'b1' });
    expect(container.querySelector('[data-session-group-header="ws_b"] [data-session-group-current]')?.textContent).toBe('Current');
    expect(container.querySelector('[data-session-group-header="ws_a"] [data-session-group-current]')).toBeNull();
  });

  it('pins a workspace from its header, as a sibling of the fold toggle', async () => {
    const { container } = await mount(grouped());
    const pin = container.querySelector<HTMLButtonElement>('[data-session-group-pin="ws_b"]')!;
    expect(pin.closest('[data-session-group]')).toBeNull();
    expect(pin.getAttribute('aria-label')).toBe('Pin the workspace beta to the top');
    expect(container.querySelector('[data-session-group-header="ws_a"] [data-session-group-pinned]')).not.toBeNull();
    await act(async () => { pin.click(); });
    expect(setWorkspacePinned).toHaveBeenCalledWith('ws_b', true);
    // Pinning does not fold the group.
    expect(container.querySelector('[data-session-group="ws_b"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers folds and "show all" per connection across remounts', async () => {
    const first = await mount(grouped());
    await act(async () => { first.container.querySelector<HTMLButtonElement>('[data-session-group="ws_a"]')!.click(); });
    expect(readWorkspaceGroupMemory('local').collapsed).toEqual(['ws_a']);
    act(() => { first.root.unmount(); });
    const second = await mount(grouped());
    expect(second.container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(second.container.querySelector('[data-session-row="a1"]')).toBeNull();
    act(() => { second.root.unmount(); });
    connectionScope.id = 'remote';
    const other = await mount(grouped());
    expect(other.container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the memory inside the active space', () => {
    writeWorkspaceGroupMemory('local', { collapsed: ['ws_a'] });
    configureSpaceStorage({ homeId: 'work' });
    expect(readWorkspaceGroupMemory('local').collapsed).toEqual([]);
    writeWorkspaceGroupMemory('local', { collapsed: ['ws_b'] });
    expect(localStorage.getItem('kiki.space.work.kiki.sidebar.workspaceGroups')).toContain('ws_b');
    configureSpaceStorage(null);
    expect(readWorkspaceGroupMemory('local').collapsed).toEqual(['ws_a']);
  });

  it('restores the remembered scroll position', async () => {
    writeWorkspaceGroupMemory('local', { scrollTop: 240 });
    const { container } = await mount(grouped());
    expect(container.querySelector<HTMLElement>('[data-session-list]')?.scrollTop).toBe(240);
  });

  it('folds and unfolds every workspace at once', async () => {
    const { container } = await mount(grouped());
    const all = () => container.querySelector<HTMLButtonElement>('[data-session-groups-fold-all]')!;
    expect(all().getAttribute('aria-label')).toBe('Collapse all workspaces');
    await act(async () => { all().click(); });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(0);
    expect(all().getAttribute('aria-label')).toBe('Expand all workspaces');
    await act(async () => { all().click(); });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(2);
  });

  it('shows matches inside folded groups while a filter runs, counted against the workspace', async () => {
    writeWorkspaceGroupMemory('local', { collapsed: ['ws_a'] });
    const extra = { ...session('a2'), workspace_id: 'ws_a' };
    const { container } = await mount({
      ...grouped(),
      sessions: [inA, extra, inB],
      filters: { status: [], workspaces: ['ws_a'], archived: 'hide' },
      sessionGroups: [{ key: 'ws_a', label: 'alpha', items: [inA] }],
    });
    expect(container.querySelector('[data-session-row="a1"]')).not.toBeNull();
    expect(container.querySelector('[data-session-group-header="ws_a"] [data-session-group-count]')?.textContent).toBe('1 of 2');
    // No fold toggle while filtered, and no fold-all; the fold itself is kept.
    expect(container.querySelector('button[data-session-group="ws_a"]')).toBeNull();
    expect(container.querySelector('[data-session-groups-fold-all]')).toBeNull();
    expect(readWorkspaceGroupMemory('local').collapsed).toEqual(['ws_a']);
  });

  it('gives Pinned the same header: chevron, count, neutral ink, remembered fold, no pin action', async () => {
    const pinned = { ...session('p1'), workspace_id: 'ws_b', metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } as Session['metadata'] };
    const props = (): SidebarOverrides => ({
      ...grouped(),
      sessions: [pinned, inA, inB],
      sessionGroups: [
        { key: 'pinned', label: 'Pinned', items: [pinned] },
        { key: 'ws_a', label: 'alpha', items: [inA] },
        { key: 'ws_b', label: 'beta', items: [inB] },
      ],
    });
    const first = await mount(props());
    const header = () => first.container.querySelector<HTMLButtonElement>('button[data-session-group="pinned"]')!;
    const workspaceHeader = first.container.querySelector<HTMLButtonElement>('button[data-session-group="ws_a"]')!;
    // One component, one class list: the pinned bucket lines up with the workspaces.
    expect(header().className).toBe(workspaceHeader.className);
    expect(header().className).toContain('text-ink-soft');
    expect(header().className).not.toContain('text-section-ink');
    expect(header().querySelector('svg')).not.toBeNull();
    expect(header().querySelector('[data-session-group-count]')?.textContent).toBe('1');
    expect(first.container.querySelector('[data-session-group-pin="pinned"]')).toBeNull();
    await act(async () => { header().click(); });
    expect(first.container.querySelector('[data-session-row="p1"]')).toBeNull();
    expect(readWorkspaceGroupMemory('local').collapsed).toEqual(['pinned']);
    act(() => { first.root.unmount(); });
    const second = await mount(props());
    expect(second.container.querySelector('[data-session-group="pinned"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(second.container.querySelector('[data-session-row="p1"]')).toBeNull();
  });

  it('keeps accent ink off group names; only the Current mark carries it', async () => {
    const { container } = await mount({ ...grouped(), activeSessionId: 'a1' });
    const header = container.querySelector('[data-session-group-header="ws_a"]')!;
    const tinted = [...header.querySelectorAll('[class*="text-selected-ink"], [class*="text-accent"], [class*="text-section-ink"]')];
    expect(tinted.map((node) => node.hasAttribute('data-session-group-current'))).toEqual([true]);
  });

  it('never preview-truncates Pinned, and folds it with "collapse all"', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      ...session(`pin${index}`),
      metadata: { cwd: 'C:/tmp', [SESSION_PIN_META_KEY]: true } as Session['metadata'],
    }));
    const { container } = await mount({
      ...grouped(),
      sessions: [...many, inA],
      sessionGroups: [{ key: 'pinned', label: 'Pinned', items: many }, { key: 'ws_a', label: 'alpha', items: [inA] }],
    });
    expect(container.querySelectorAll('[data-session-group-block="pinned"] [data-session-row]')).toHaveLength(10);
    expect(container.querySelector('[data-session-group-more="pinned"]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-session-groups-fold-all]')!.click(); });
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(0);
  });
});

describe('Sidebar room rows', () => {
  function roomSummary(overrides: Partial<RoomListItem> & { id: string }): RoomListItem {
    return {
      kind: 'room',
      title: overrides.id,
      workspace: 'ws_test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastSeq: 0,
      memberCount: 2,
      busy: false,
      needsYou: false,
      pendingInteraction: 'none',
      failed: false,
      pinned: false,
      archived: false,
      ...overrides,
    };
  }

  function roomDocument(room: RoomListItem, paused = false): RoomDocument {
    return {
      version: 1,
      id: room.id,
      name: room.title,
      members: [],
      host: 'lin-lan',
      mode: 'mention',
      budget: { botMessagesPerUserMessage: 4 },
      workspace: room.workspace,
      createdAt: room.createdAt,
      pinned: room.pinned,
      archived: room.archived,
      generation: 0,
      paused,
      budgetUsed: 0,
      userMessageCount: 0,
      cursors: {},
    };
  }

  /** The real projection: the row reads the merged conversation item. */
  function roomItem(room: RoomListItem): ConversationListItem {
    const item = mergeConversationItems([], [room], {})[0];
    if (item === undefined) throw new Error('room item not built');
    return item;
  }

  function listedRoom(room: RoomListItem): SidebarOverrides {
    return {
      rooms: [room],
      sessionGroups: [{ key: 'today', label: 'Today', items: [roomItem(room)] }],
    };
  }

  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  async function openRoomMenu(container: HTMLDivElement): Promise<HTMLElement> {
    const row = container.querySelector('[data-room-title]');
    if (row === null) throw new Error('room row not rendered');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const menu = container.querySelector<HTMLElement>('[data-room-menu]');
    if (menu === null) throw new Error('room menu did not open');
    return menu;
  }

  it('renders a room as a thread-style row with the # mark, and opens it', async () => {
    const room = roomSummary({ id: 'room_1', title: '0.31 发布' });
    const { container } = await mount(listedRoom(room));
    const row = container.querySelector('[data-room-row="room_1"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-room-kind]')?.textContent).toBe('#');
    expect(row?.textContent).toContain('0.31 发布');
    expect(row?.getAttribute('data-room-row-state')).toBe('read');
    await act(async () => { row!.querySelector('button')!.click(); });
    expect(row?.querySelector('button')?.getAttribute('aria-current')).toBe('page');
  });

  it('carries the thread row states: unread, needs you (approval and budget)', async () => {
    const unread = roomSummary({ id: 'room_unread', lastSeq: 3 });
    const approval = roomSummary({ id: 'room_approval', needsYou: true, pendingInteraction: 'approval' });
    const budget = roomSummary({ id: 'room_budget', needsYou: true, pendingInteraction: 'none' });
    const { container } = await mount({
      rooms: [unread, approval, budget],
      sessionGroups: [{ key: 'today', label: 'Today', items: [roomItem(unread), roomItem(approval), roomItem(budget)] }],
    });
    expect(container.querySelector('[data-room-row="room_unread"]')?.getAttribute('data-room-row-state')).toBe('unread');
    const approvalRow = container.querySelector('[data-room-row="room_approval"]');
    expect(approvalRow?.getAttribute('data-room-row-state')).toBe('needs-me');
    expect(approvalRow?.querySelector('[data-room-needs-you]')?.textContent).toBe('Awaiting approval');
    const budgetRow = container.querySelector('[data-room-row="room_budget"]');
    expect(budgetRow?.getAttribute('data-room-row-state')).toBe('needs-me');
    expect(budgetRow?.querySelector('[data-room-needs-you]')?.textContent).toBe('Room budget exhausted');
  });

  it('pins from the hover affordance through the room API', async () => {
    roomRest.update.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' }), false));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1' })));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-pin-toggle]')!.click(); });
    expect(roomRest.update).toHaveBeenCalledWith('room_1', { pinned: true });
  });

  it('copies the deep link from the menu', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1' })));
    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="copy-link"]')!.click(); });
    expect(writeText).toHaveBeenCalledWith('/rooms/room_1');
    expect(container.querySelector('[data-room-menu]')).toBeNull();
  });

  it('lists members / budget / pause ahead of the shared lifecycle entries', async () => {
    const room = roomSummary({ id: 'room_1' });
    // Hold the room document back so the pause entry shows its waiting state.
    let resolveRoom!: (value: unknown) => void;
    roomRest.get.mockReturnValue(new Promise((resolve) => { resolveRoom = resolve; }));
    roomRest.pause.mockResolvedValue(roomDocument(room, true));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1' })));
    const menu = await openRoomMenu(container);
    const order = [...menu.querySelectorAll('[data-menu-item]')].map((node) => node.getAttribute('data-menu-item'));
    expect(order).toEqual(['members', 'budget', 'pause', 'copy-link', 'pin', 'rename', 'archive', 'delete']);
    // The pause label waits for the full room document, then offers Pause.
    const pause = menu.querySelector<HTMLButtonElement>('[data-menu-item="pause"]')!;
    expect(pause.disabled).toBe(true);
    await act(async () => { resolveRoom(roomDocument(room, false)); });
    await settle();
    expect(pause.disabled).toBe(false);
    expect(pause.textContent).toBe('Pause');
    await act(async () => { pause.click(); });
    expect(roomRest.pause).toHaveBeenCalledWith('room_1');
  });

  it('resumes a paused room from the same entry', async () => {
    const room = roomSummary({ id: 'room_1' });
    roomRest.get.mockResolvedValue(roomDocument(room, true));
    roomRest.continue.mockResolvedValue(roomDocument(room, false));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1' })));
    const menu = await openRoomMenu(container);
    await settle();
    const pause = container.querySelector<HTMLButtonElement>('[data-room-menu] [data-menu-item="pause"]')!;
    expect(pause.textContent).toBe('Resume discussion');
    await act(async () => { pause.click(); });
    expect(roomRest.continue).toHaveBeenCalledWith('room_1');
  });

  it('renames through the shared dialog with the room heading', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    roomRest.update.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1', title: '0.31 发布' })));
    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="rename"]')!.click(); });
    // The dialog renders through a body portal.
    const dialog = document.body.querySelector('[aria-label="Rename room"]');
    expect(dialog).not.toBeNull();
    const input = dialog!.querySelector('input')!;
    expect(input.value).toBe('0.31 发布');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '0.32 发布');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...dialog!.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save.click(); });
    expect(roomRest.update).toHaveBeenCalledWith('room_1', { name: '0.32 发布' });
  });

  it('deletes through the confirmation dialog', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    roomRest.delete.mockResolvedValue(undefined);
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1', title: '0.31 发布' })));
    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="delete"]')!.click(); });
    const dialog = container.querySelector('[aria-label="Delete “0.31 发布”?"]');
    expect(dialog).not.toBeNull();
    await act(async () => { dialog!.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    await settle();
    expect(roomRest.delete).toHaveBeenCalledWith('room_1');
    expect(container.querySelector('[data-confirm-action="confirm"]')).toBeNull();
  });

  it('restores or deletes an archived room, with no pin affordance', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' }), false));
    const room = roomSummary({ id: 'room_1', archived: true });
    const { container } = await mount(listedRoom(room));
    expect(container.querySelector('[data-room-pin-toggle]')).toBeNull();
    const menu = await openRoomMenu(container);
    const order = [...menu.querySelectorAll('[data-menu-item]')].map((node) => node.getAttribute('data-menu-item'));
    expect(order).toEqual(['copy-link', 'delete']);
    expect(menu.textContent).toContain('Restore');
    roomRest.update.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === 'Restore')!.click();
    });
    expect(roomRest.update).toHaveBeenCalledWith('room_1', { archived: false });
  });

  it('shows the rooms fetch failure instead of an empty list', async () => {
    const { container } = await mount({
      roomsQuery: { isError: true },
      sessionGroups: [{ key: 'today', label: 'Today', items: [session('one')] }],
    });
    expect(container.querySelector('[data-rooms-error]')?.textContent).toContain('Could not load rooms');
  });
});

describe('collapsed icon rail', () => {
  // The two breakpoints the sidebar reads: desktop starts at 768px, the
  // automatic collapse runs until 1280px. A stored sidebarCollapsed override
  // wins over both.
  function stubViewportWidth(width: number): void {
    vi.stubGlobal('matchMedia', (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: minWidth !== null
          ? width >= Number(minWidth[1])
          : maxWidth !== null
            ? width <= Number(maxWidth[1])
            : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    });
  }

  it('collapses to the icon rail by default between 768px and 1279px', async () => {
    stubViewportWidth(1100);
    const { container } = await mount();
    const aside = container.querySelector<HTMLElement>('[data-session-sidebar]');
    expect(aside?.getAttribute('data-sidebar-collapsed')).toBe('true');
    expect(aside?.style.getPropertyValue('--kiki-sidebar-width')).toBe('56px');
    // No resizer, no session list, no search: the rail is destinations only.
    expect(container.querySelector('[data-sidebar-resizer]')).toBeNull();
    expect(container.querySelector('[data-session-list]')).toBeNull();
    expect(container.querySelector('[data-search-toggle]')).toBeNull();
    expect(container.querySelector('[data-new-session]')).not.toBeNull();
    for (const hook of ['board', 'cron', 'memory', 'personas', 'usage', 'capabilities']) {
      const button = container.querySelector(`[data-nav-${hook}]`);
      expect(button).not.toBeNull();
      expect(button?.getAttribute('title')).not.toBe('');
    }
    expect(container.querySelector('[data-nav-settings]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="expand"]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="collapse"]')).toBeNull();
  });

  it('stays expanded by default at 1280px and wider', async () => {
    stubViewportWidth(1440);
    const { container } = await mount();
    expect(container.querySelector('[data-session-sidebar]')?.getAttribute('data-sidebar-collapsed')).toBeNull();
    expect(container.querySelector('[data-sidebar-resizer]')).not.toBeNull();
    expect(container.querySelector('[data-session-list]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="collapse"]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="expand"]')).toBeNull();
  });

  // Last in the file on purpose: the override is a persisted module-level
  // snapshot with no "back to automatic" write, so this test owns the tail.
  it('toggle writes the sidebarCollapsed override and switches the layout', async () => {
    stubViewportWidth(1100);
    const { container } = await mount();
    expect(container.querySelector('[data-session-sidebar]')?.getAttribute('data-sidebar-collapsed')).toBe('true');

    const expand = container.querySelector<HTMLButtonElement>('[data-sidebar-toggle="expand"]');
    if (expand === null) throw new Error('expand toggle not rendered');
    await act(async () => { expand.click(); });
    expect(readLayoutPreferences().sidebarCollapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem('kiki.layout') ?? '{}').sidebarCollapsed).toBe(false);
    expect(container.querySelector('[data-session-sidebar]')?.getAttribute('data-sidebar-collapsed')).toBeNull();
    expect(container.querySelector('[data-session-list]')).not.toBeNull();

    const collapse = container.querySelector<HTMLButtonElement>('[data-sidebar-toggle="collapse"]');
    if (collapse === null) throw new Error('collapse toggle not rendered');
    await act(async () => { collapse.click(); });
    expect(readLayoutPreferences().sidebarCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('kiki.layout') ?? '{}').sidebarCollapsed).toBe(true);
    expect(container.querySelector('[data-session-sidebar]')?.getAttribute('data-sidebar-collapsed')).toBe('true');
    expect(container.querySelector('[data-session-list]')).toBeNull();
  });
});

it('keeps time-group headings in nonshrinking normal flow instead of overlaying long session titles', async () => {
  writeLayoutPreferences({ sidebarCollapsed: false });
  const one = { ...session('one'), title: 'A very long session title '.repeat(10) };
  const two = { ...session('two'), title: 'Another long title '.repeat(10) };
  const { container } = await mount({ sessions: [one, two], groupBy: 'time', sessionGroups: [
    { key: 'today', label: 'Today', items: [one] },
    { key: 'week', label: 'Last 7 days', items: [two] },
  ] });
  for (const heading of container.querySelectorAll<HTMLElement>('[data-session-group]')) {
    expect(heading.classList.contains('sticky')).toBe(false);
    expect(heading.classList.contains('shrink-0')).toBe(true);
    expect(heading.classList.contains('min-h-7')).toBe(true);
    expect(heading.querySelector('span')?.classList.contains('truncate')).toBe(true);
  }
  expect(container.querySelectorAll('[data-session-group]')).toHaveLength(2);
});
