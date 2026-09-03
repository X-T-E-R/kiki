// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@moonshot-ai/protocol';

import {
  SEARCH_DEBOUNCE_MS,
  SESSION_PIN_META_KEY,
  type SessionGroup,
} from '@kiki/session-core/sessions';
import { I18nProvider } from '../i18n';
import type { SearchMessageHit, SearchMessagesResponse } from '../lib/client';
import {
  mergeSearchPages,
  searchNextPageParam,
  Sidebar,
} from './Sidebar';

const searchMessages = vi.fn();
const setWorkspacePinned = vi.fn(async () => {});

vi.mock('../state/connection', () => ({
  useOptionalControllerRegistry: () => null,
  useConnection: () => ({
    client: { searchMessages, setWorkspacePinned },
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
  setWorkspacePinned.mockClear();
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

type SidebarProps = ComponentProps<typeof Sidebar>;

async function mount(
  overrides: Partial<SidebarProps> = {},
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
              sessions={[]}
              sessionGroups={[]}
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
              {...overrides}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
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
  it('puts usage on the wordmark row (capabilities moved into settings)', async () => {
    const { container } = await mount();
    expect(container.querySelector('[data-nav-capabilities]')).toBeNull();
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
      ...container.querySelectorAll<HTMLElement>('[role="group"][aria-label]'),
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

  it('exposes the search results as a named region while a query is active', async () => {
    searchMessages.mockResolvedValue(page([A1, A2], false));
    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');

    const regions = [...container.querySelectorAll<HTMLElement>('[role="region"][aria-label]')];
    expect(regions.map((node) => node.getAttribute('aria-label'))).toEqual(['Search sessions']);
    expect(regions[0]?.hasAttribute('data-search-results')).toBe(true);
    expect(container.querySelector('[data-session-list]')).toBeNull();
  });
});

describe('Sidebar view menu', () => {
  const wsA = workspace('wd_a_000000000000', 'workshop', true);
  const wsB = workspace('wd_b_000000000000', 'another-ws');
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return {
      sessions: [one],
      sessionGroups: [{ key: 'today', label: 'Today', items: [one] }],
    };
  };

  it('leaves no select element anywhere in the sidebar', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await openViewMenu(container);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('keeps the default chrome down to six controls with the view options collapsed', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
    // Chrome only: the session rows and their hover affordances live in the
    // scroller, which this filter drops.
    const chrome = [...container.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter(
      (element) => element.closest('[data-session-list]') === null,
    );
    expect(chrome).toHaveLength(6);
    expect(container.querySelector('[data-nav-usage]')).not.toBeNull();
    expect(container.querySelector('[data-search-box]')).not.toBeNull();
    expect(container.querySelector('[data-view-menu-toggle]')).not.toBeNull();
    expect(container.querySelector('[data-connection-status]')).not.toBeNull();
    // Grouping, sorting and scope are no longer resident.
    expect(container.querySelector('[data-group-by]')).toBeNull();
    expect(container.querySelector('[data-sort-by]')).toBeNull();
    expect(container.querySelector('[data-workspace-filter]')).toBeNull();
  });

  it('drops the list-bottom archived toggle in favour of the menu entry', async () => {
    const { container } = await mount(listed());
    expect(container.querySelector('[data-session-list]')?.textContent ?? '').not.toContain('Show archived');
    const menu = await openViewMenu(container);
    expect(menu.querySelector('[data-show-archived]')).not.toBeNull();
  });

  it('reports the current selection and writes grouping, sorting and archived through', async () => {
    const onGroupBy = vi.fn();
    const onSortBy = vi.fn();
    const onToggleArchived = vi.fn();
    const { container } = await mount({
      ...listed(),
      groupBy: 'time',
      sortBy: 'updated-desc',
      onGroupBy,
      onSortBy,
      onToggleArchived,
    });
    const menu = await openViewMenu(container);
    expect(menu.querySelector('[data-group-by="time"]')?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-sort-by="updated-desc"]')?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-show-archived]')?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-group-by="workspace"]')?.click();
      menu.querySelector<HTMLButtonElement>('[data-sort-by="title"]')?.click();
      menu.querySelector<HTMLButtonElement>('[data-show-archived]')?.click();
    });
    expect(onGroupBy).toHaveBeenCalledWith('workspace');
    expect(onSortBy).toHaveBeenCalledWith('title');
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
    // View preferences do not dismiss the panel; the list rearranges behind it.
    expect(container.querySelector('[data-view-menu]')).not.toBeNull();
  });

  it('scopes the list to one workspace and back to all from the same section', async () => {
    const onWorkspaceFilter = vi.fn();
    const { container } = await mount({
      ...listed(),
      workspaceOptions: [wsA, wsB],
      workspaceFilter: wsA.id,
      onWorkspaceFilter,
    });
    const menu = await openViewMenu(container);
    expect(menu.querySelector(`[data-workspace-filter="${wsA.id}"]`)?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-workspace-filter=""]')?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-workspace-filter="${wsB.id}"]`)?.click();
    });
    expect(onWorkspaceFilter).toHaveBeenCalledWith(wsB.id);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-workspace-filter=""]')?.click();
    });
    expect(onWorkspaceFilter).toHaveBeenLastCalledWith(undefined);
    expect(menu.querySelector('[data-manage-workspaces]')).not.toBeNull();
  });

  it('carries the per-row workspace pin toggle into the menu', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
    const menu = await openViewMenu(container);
    const pins = [...menu.querySelectorAll<HTMLButtonElement>('[data-workspace-pin-toggle]')];
    expect(pins).toHaveLength(2);
    expect(pins[0]?.getAttribute('aria-label')).toBe('Unpin the workspace workshop');
    expect(pins[1]?.getAttribute('aria-label')).toBe('Pin the workspace another-ws to the top');
    await act(async () => {
      pins[1]?.click();
    });
    expect(setWorkspacePinned).toHaveBeenCalledWith(wsB.id, true);
  });

  it('hides the workspace section when the server reports none', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [] });
    const menu = await openViewMenu(container);
    expect(menu.querySelector('[data-workspace-filter]')).toBeNull();
    expect(menu.querySelector('[data-group-by="time"]')).not.toBeNull();
  });
});

describe('Sidebar filter chips', () => {
  const wsA = workspace('wd_a_000000000000', 'workshop', true);
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return { sessions: [one], sessionGroups: [{ key: 'today', label: 'Today', items: [one] }] };
  };

  it('renders nothing while both filters sit at their defaults', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [wsA] });
    expect(container.querySelector('[data-sidebar-filters]')).toBeNull();
  });

  it('traces an active workspace scope and resets it from the chip', async () => {
    const onWorkspaceFilter = vi.fn();
    const { container } = await mount({
      ...listed(),
      workspaceOptions: [wsA],
      workspaceFilter: wsA.id,
      onWorkspaceFilter,
    });
    const chip = container.querySelector<HTMLElement>('[data-sidebar-filter-chip="workspace"]');
    expect(chip?.textContent).toContain('workshop');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sidebar-filter-clear="workspace"]')?.click();
    });
    expect(onWorkspaceFilter).toHaveBeenCalledWith(undefined);
  });

  it('traces archived visibility and reopens the menu from the chip body', async () => {
    const onToggleArchived = vi.fn();
    const { container } = await mount({ ...listed(), showArchived: true, onToggleArchived });
    const chip = container.querySelector<HTMLElement>('[data-sidebar-filter-chip="archived"]');
    expect(chip?.textContent).toContain('Including archived');
    await act(async () => {
      chip?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(container.querySelector('[data-view-menu]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sidebar-filter-clear="archived"]')?.click();
    });
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly one archived entry on the empty state', async () => {
    const { container } = await mount({ sessions: [], sessionGroups: [] });
    const entries = [...container.querySelectorAll('button')].filter((element) =>
      (element.textContent ?? '').includes('archived'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.closest('[data-sidebar-empty]')).not.toBeNull();
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

  it('copies the in-app route and the session cwd from the new group', async () => {
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    expect(menu.querySelector('[data-menu-item="copy-link"]')?.textContent).toBe('Copy link');
    expect(menu.querySelector('[data-menu-item="copy-path"]')?.textContent).toBe('Copy path');
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