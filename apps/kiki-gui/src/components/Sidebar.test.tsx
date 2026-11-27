// @vitest-environment jsdom

import { act, useLayoutEffect, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, type NavigateOptions, type To } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoomDocument, RoomListItem, Session, Workspace } from '@kiki/protocol';

import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  groupConversationItems,
  isPinnedSession,
  mergeConversationItems,
  SESSION_PIN_META_KEY,
  WORKSPACE_UNGROUPED_KEY,
  type ConversationListItem,
  type SessionGroup,
  type SessionSortOrder,
} from '@kiki/session-core/sessions';
import { subscribeComposerInserts } from '@kiki/session-core/composer';
import { ApiError } from '@kiki/session-core/transport';
import {
  DEFAULT_PINNED_NAV_ITEMS,
  DEFAULT_SESSION_LIST_FILTERS,
  markSessionSeen,
  readLayoutPreferences,
  resetConversationSeen,
  resetConversationTriage,
  resetLayoutPreferencesForTests,
  writeLayoutPreferences,
  resetSessionSeen,
} from '@kiki/session-core/settings';
import { HostProvider, browserHost, type HostAdapter } from '../host';
import { I18nProvider } from '../i18n';
import type { SearchMessageHit, SearchMessagesResponse } from '../lib/client';
import { resetPendingConversationOpens } from '../lib/conversationOpen';
import { registerScopeNavigation } from '../lib/navScope';
import { clearToasts, getToasts } from '../lib/toasts';
import {
  registerSessionPluginPanelOpener,
  resetSessionPluginPanelOpenersForTests,
} from '../lib/pluginPanelPreview';
import { nestSessionThreads, sessionRelationOf } from '../lib/sessionThreads';
import { requestSessionSearch } from '../lib/sidebarSearch';
import { configureSpaceStorage } from '../lib/spaceStorage';
import { readWorkspaceGroupMemory, writeWorkspaceGroupMemory } from '../lib/sidebarGroupMemory';
import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';
import { createViewState } from '@kiki/session-core/session';
import { canAbortActiveTurn, shouldHandleGlobalAbortOnEscape } from './SessionView';
import { DirtyGuardContext, useDirtyGuardState } from './dirtyGuard';
import {
  mergeSearchPages,
  searchNextPageParam,
  Sidebar,
} from './Sidebar';

const searchMessages = vi.fn();
const getSession = vi.fn<(id: string) => Promise<Session>>();
const retrySearchIndexer = vi.fn(async () => ({ retried: true }));
const setWorkspacePinnedCatalog = vi.fn(async () => {});
const listEphemeralSessions = vi.fn(async (_query?: { before_id?: string; page_size?: number }): Promise<{ items: Session[]; has_more?: boolean; next_cursor?: string }> => ({ items: [] }));
/** The persona roster the 角色 group reads; empty unless a test wants one. */
const listPersonas = vi.fn(async (): Promise<readonly unknown[]> => []);
const connectionScope = vi.hoisted(() => ({
  id: 'local',
  spaceKey: 'main',
  localSpaceKey: 'main',
  localScopeId: 'local',
  ws: 'open' as 'open' | 'connecting' | 'closed',
  brokerConfig: undefined as { url: string; token: string } | undefined,
}));
/** The runtime config the room entry reads; pending (unknown) unless a test settles it. */
const getConfig = vi.fn<() => Promise<unknown>>();
const listTasks = vi.fn(async (): Promise<{ items: unknown[] }> => ({ items: [] }));
const listPrompts = vi.fn(async (): Promise<unknown> => ({ active: null, queued: [] }));
// The row menu's archive call; held back by a test to read the pending state.
// The shape is the family response the backend contract defines: a per
// conversation outcome list, never a bare "archived".
type ArchiveFamilyResponse = { archived: boolean; outcomes: { id: string; ok: true }[] };
const archiveSession = vi.fn<(
  id: string,
  options?: { include_attached?: boolean; exclude_session_ids?: string[] },
) => Promise<ArchiveFamilyResponse>>();
/** A family archive that confirmed exactly one conversation. */
const archived = (id: string): ArchiveFamilyResponse => ({ archived: true, outcomes: [{ id, ok: true }] });
const restoreSession = vi.fn(async () => { throw new Error('not stubbed'); });
const updateSession = vi.fn(async (_id: string, body: Record<string, unknown>) => ({ id: _id, ...body }));
const updateSessionProfile = vi.fn(async (id: string, body: Record<string, unknown>) => ({ id, ...body }));
const forkSessionMock = vi.fn(async (id: string, body: Record<string, unknown> = {}) => ({ ...session(`${id}_fork`), ...body }));
const createBranchMock = vi.fn(async (_id: string, body: { seed?: string } = {}) => ({
  agent_id: 'branch_1',
  parent_agent_id: 'main',
  seed: body.seed ?? 'fresh',
  tools_locked: false,
  started: false,
}));
const compactSession = vi.fn<(id: string, body: Record<string, never>) => Promise<unknown>>();
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

vi.mock('../state/connection', () => {
  const readConnection = () => ({
    client: {
      getSession,
      getRequestGovernance: async () => ({ domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z', active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' }, dimensions: [], rules: [], waiting: [] }),
      searchMessages,
      retrySearchIndexer,
      setWorkspacePinnedCatalog,
      listEphemeralSessions,
      listTasks,
      listPrompts,
      listPersonas,
      archiveSession,
      compactSession,
      getConfig,
      restoreSession,
      updateSession,
      forkSession: forkSessionMock,
      createBranch: createBranchMock,
      updateSessionProfile,
      klient: { rest: { rooms: roomRest } },
    },
    scopeId: connectionScope.id,
    spaceKey: connectionScope.spaceKey,
    localSpaceKey: connectionScope.localSpaceKey,
    localScopeId: connectionScope.localScopeId,
    config: connectionScope.brokerConfig,
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
    wsStatus: connectionScope.ws,
    disconnect: () => {},
  });
  return {
    useOptionalControllerRegistry: () => null,
    useOptionalConnection: readConnection,
    useConnection: readConnection,
  };
});

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

/** A fixture instant inside the pinned clock's own day, so a time-bucketed
 * group does not depend on the machine's date. */
function fixtureStamp(day: number, hour = 10): string {
  return new Date(2026, 9, day, hour).toISOString();
}

/** The clock the time-bucketed fixtures are pinned to (Oct 6, 12:00 local). */
const FIXTURE_NOW_MS = new Date(2026, 9, 6, 12).getTime();

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
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
  setWorkspacePinnedCatalog.mockClear();
  listEphemeralSessions.mockReset();
  listEphemeralSessions.mockResolvedValue({ items: [] });
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
  archiveSession.mockReset();
  archiveSession.mockImplementation(async (id: string) => archived(id));
  updateSession.mockReset();
  updateSession.mockImplementation(async (id: string, body: Record<string, unknown>) => ({ id, ...body }));
  updateSessionProfile.mockReset();
  updateSessionProfile.mockImplementation(async (id: string, body: Record<string, unknown>) => ({ id, ...body }));
  forkSessionMock.mockReset();
  forkSessionMock.mockImplementation(async (id: string, body: Record<string, unknown> = {}) => ({ ...session(`${id}_fork`), ...body }));
  createBranchMock.mockReset();
  createBranchMock.mockImplementation(async (_id: string, body: { seed?: string } = {}) => ({
    agent_id: 'branch_1',
    parent_agent_id: 'main',
    seed: body.seed ?? 'fresh',
    tools_locked: false,
    started: false,
  }));
  for (const fn of Object.values(roomRest)) fn.mockReset();
  getConfig.mockReset();
  getConfig.mockReturnValue(new Promise(() => {}));
  connectionScope.id = 'local';
  connectionScope.spaceKey = 'main';
  connectionScope.localSpaceKey = 'main';
  connectionScope.localScopeId = 'local';
  connectionScope.ws = 'open';
  connectionScope.brokerConfig = undefined;
  // Workspace folds and the list scroll persist across mounts.
  localStorage.removeItem('kiki.sidebar.workspaceGroups');
  localStorage.removeItem('kiki.sidebar.topLevelThreads');
  // Layout preferences (collapse, secondary-nav fold) are per-test state;
  // without this a test that expands a section leaks it into the next one's
  // "preference unset" premise.
  localStorage.removeItem('kiki.layout');
  resetLayoutPreferencesForTests();
  resetConversationSeen();
  resetConversationTriage();
  resetPendingConversationOpens();
  configureSpaceStorage(null);
});

afterEach(() => {
  // Unmount every root a test mounted: portaled dialogs keep their window
  // keydown listeners alive otherwise (removing the container is not enough),
  // and a leaked modal eats the next test's trusted Escape. Roots a test
  // already unmounted itself are skipped.
  for (const root of roots.splice(0)) {
    try {
      act(() => { root.unmount(); });
    } catch {
      // The test unmounted this root itself.
    }
  }
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
  resetSessionSeen();
  resetConversationSeen();
  resetConversationTriage();
  resetPendingConversationOpens();
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
type SidebarGuard = {
  dirty: boolean;
  rawNavigate: (target: To | number, options?: NavigateOptions) => void;
  seat?: { current: ReturnType<typeof useDirtyGuardState> | null };
};

type SidebarOverrides = Omit<Partial<SidebarProps>, 'sessionGroups'> & {
  sessionGroups?: readonly SessionGroup<Session | ConversationListItem>[];
  initialEntries?: readonly string[];
  guard?: SidebarGuard;
};

function MaybeGuard({ guard, children }: { guard: SidebarGuard | undefined; children: ReactNode }) {
  if (guard === undefined) return children;
  return <GuardFrame guard={guard}>{children}</GuardFrame>;
}

function GuardFrame({ guard, children }: { guard: SidebarGuard; children: ReactNode }) {
  const location = useLocation();
  const state = useDirtyGuardState(location, guard.rawNavigate);
  if (guard.seat !== undefined) guard.seat.current = state;
  useLayoutEffect(() => {
    state.value.reportDirty('unsaved-editor', guard.dirty);
  });
  return <DirtyGuardContext.Provider value={state.value}>{children}</DirtyGuardContext.Provider>;
}

async function mount(
  overrides: SidebarOverrides = {},
  host: HostAdapter = browserHost,
  cachedSessions: readonly Session[] = [],
): Promise<{ container: HTMLDivElement; root: Root; queryClient: QueryClient; render: (next: SidebarOverrides) => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedSessions.length > 0) client.setQueryData(['sessions', 'cached'], { pages: [{ items: cachedSessions }] });
  const render = async (next: SidebarOverrides) => {
    const { sessionGroups: rawGroups, initialEntries, guard, sidebarMode: nextSidebarMode, nowMs: nextNowMs, ...rest } = next;
    const sidebarMode = 'sidebarMode' in next ? nextSidebarMode : 'sessions';
    const nowMs = 'nowMs' in next ? nextNowMs : Date.parse('2026-01-02T00:00:00.000Z');
    const sessionGroups = (rawGroups ?? []).map((group) => ({
      ...group,
      items: group.items.map((item) => ('kind' in item ? item : threadItem(item))),
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <HostProvider host={host}>
              <MemoryRouter initialEntries={initialEntries as string[] | undefined}>
                <MaybeGuard guard={guard}>
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
                  sidebarMode={sidebarMode}
                  nowMs={nowMs}
                  {...rest}
                />
                </MaybeGuard>
              </MemoryRouter>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await render(overrides);
  return { container, root, queryClient: client, render };
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
  const menu = document.querySelector<HTMLElement>('[data-view-menu]');
  if (menu === null) throw new Error('view menu did not open');
  return menu;
}

async function openFilterMenu(container: HTMLDivElement): Promise<HTMLElement> {
  const toggle = container.querySelector<HTMLButtonElement>('[data-filter-menu-toggle]');
  if (toggle === null) throw new Error('filter menu trigger not rendered');
  await act(async () => {
    toggle.click();
  });
  const menu = document.querySelector<HTMLElement>('[data-filter-menu]');
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
  it('keeps the tool-output toggle out of the sidebar search and uses the default text search', async () => {
    searchMessages.mockImplementation(async (body: { include_tool_output?: boolean; page_token?: string }) =>
      body.page_token === 'body-next' ? page([A2], false) : page([A1], true, 'body-next'));
    const { container } = await mount();
    await typeQuery(container, 'alpha');
    await waitForText(container, 'alpha one');
    expect(container.querySelector('[data-search-tools]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-search-load-more]')!.click(); });
    await waitForText(container, 'alpha two');
    expect(searchMessages.mock.calls.at(-1)?.[0]).toMatchObject({ page_token: 'body-next' });
    expect(searchMessages.mock.calls.some(([body]) => body.include_tool_output === true)).toBe(false);
  });

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

    expect(container.querySelector('[data-search-incomplete]')?.textContent).toBe('Search time limit reached.');
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

  it('marks finished-unread runs with a quiet dot and reserves numeric count for needs-you', async () => {
    const done = { ...session('s-done'), last_turn_reason: 'completed' as const, last_seq: 6 };
    const failed = { ...session('s-failed'), last_turn_reason: 'failed' as const, last_seq: 3 };
    const { container } = await mount({
      sessions: [done, failed],
      sessionGroups: [{ key: 'today', label: 'Today', items: [done, failed] }],
    });
    const badge = container.querySelector('[data-activity-badge]');
    expect(badge?.getAttribute('data-activity-badge')).toBe('2');
    expect(badge?.textContent).toBe('');
    expect(badge?.getAttribute('data-activity-badge-tone')).toBe('unread');
    expect(container.querySelector('[data-nav-activity]')?.getAttribute('aria-label'))
      .toBe('2 new items in Activity');

    const blocked = { ...session('s-blocked-mixed'), pending_interaction: 'approval' as const, last_seq: 4 };
    const mixed = await mount({
      sessions: [blocked, done, failed],
      sessionGroups: [{ key: 'today', label: 'Today', items: [blocked, done, failed] }],
    });
    const mixedBadge = mixed.container.querySelector('[data-activity-badge]');
    expect(mixedBadge?.getAttribute('data-activity-badge')).toBe('3');
    expect(mixedBadge?.textContent).toBe('1');
    expect(mixedBadge?.getAttribute('data-activity-badge-tone')).toBe('needs-you');
  });

  it('shows the phone-drawer exit only where the shell wires onClose', async () => {
    const docked = await mount();
    expect(docked.container.querySelector('button[aria-label="Close sidebar"]')).toBeNull();

    const onClose = vi.fn();
    const { container } = await mount({ onClose });
    const exit = container.querySelector<HTMLButtonElement>('button[aria-label="Close sidebar"]')!;
    expect(exit).not.toBeNull();
    await act(async () => { exit.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('Sidebar session row states', () => {
  it('shows unconfirmed process cleanup with a visible label and preserves row actions', async () => {
    const cleanup = { ...session('cleanup'), busy: true, executing: false, cleanup_pending: true, last_turn_reason: 'completed' as const };
    const { container } = await mount({ sessions: [cleanup], sessionGroups: [{ key: 'today', label: 'Today', items: [cleanup] }] });
    const row = container.querySelector('[data-session-row="cleanup"]');
    expect(row?.getAttribute('data-session-row-state')).toBe('cleanup-pending');
    expect(row?.textContent).toContain('Process cleanup unconfirmed');
    expect(row?.querySelector('[data-session-status]')?.getAttribute('data-session-status')).toBe('cleanup-pending');
    expect(row?.querySelectorAll('button').length).toBeGreaterThan(1);
  });

  it('separates blocked, running, unread and caught-up rows', async () => {
    resetSessionSeen();
    const blocked = { ...session('s-blocked'), pending_interaction: 'question' as const, last_seq: 4 };
    const running = { ...session('s-running'), busy: true, executing: true, last_seq: 4 };
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

  it('says each state in words beside the workspace: running for how long, awaiting an answer', async () => {
    listPrompts.mockResolvedValue({
      active: { created_at: new Date(Date.now() - 224_000).toISOString(), content: 'Run the checks' },
      queued: [{ id: 'queued-1' }, { id: 'queued-2' }],
    });
    listTasks.mockResolvedValue({ items: [] });
    const running = {
      ...session('s-running-path'),
      busy: true,
      executing: true,
      main_turn_active: true,
      metadata: { cwd: 'C:/workshop/apps/kiki-gui' },
    };
    const worktree = {
      ...session('s-running-worktree'),
      busy: true,
      executing: true,
      main_turn_active: true,
      metadata: { cwd: 'C:/workshop/.kiki/worktrees/checkout' },
      worktree: { worktree_id: 'wt_1', branch: 'fix/workspace', source_root: 'D:/source/kiki', base_ref: 'refs/heads/main' },
    };
    const blocked = {
      ...session('s-question-path'),
      pending_interaction: 'question' as const,
      metadata: { cwd: '/srv/easy-agent/apps/gui' },
    };
    const items = [running, worktree, blocked];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    for (let index = 0; index < 4; index += 1) await settle();

    const runningRow = container.querySelector('[data-session-row="s-running-path"]');
    const location = runningRow?.querySelector('[data-session-location]');
    const live = runningRow?.querySelector('[data-session-live]');
    expect(location?.textContent).toBe('…/apps/kiki-gui');
    expect(location?.getAttribute('title')).toBe('C:/workshop/apps/kiki-gui');
    // One state, in words; the queue is the session's own business now and
    // only a hover over the word still lists it.
    expect(live?.textContent).toMatch(/^Running for \d:\d{2}$/);
    expect(runningRow?.textContent).not.toContain('queued');
    expect(live?.getAttribute('title')).toContain('+2 queued');
    expect(location?.parentElement).toBe(live?.parentElement);

    const worktreeLocation = container.querySelector('[data-session-row="s-running-worktree"] [data-session-location]');
    expect(worktreeLocation?.textContent).toBe('…/source/kiki');
    expect(worktreeLocation?.getAttribute('title')).toBe('D:/source/kiki');
    expect(container.querySelector('[data-session-row="s-question-path"] [data-session-location]')?.textContent)
      .toBe('…/apps/gui');
    expect(container.querySelector('[data-session-row="s-question-path"] [data-session-needs-you]')?.textContent)
      .toBe('Awaiting answer');
  });

  it('formats runs over a day as whole localized day counts', async () => {
    const startedAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    listPrompts.mockResolvedValue({ active: { created_at: startedAt, content: 'Run the checks' }, queued: [] });
    listTasks.mockResolvedValue({ items: [] });
    const running = { ...session('s-running-50h'), busy: true, executing: true, main_turn_active: true };
    const props = { sessions: [running], sessionGroups: [{ key: 'today', label: 'Today', items: [running] }] };

    try {
      localStorage.setItem('kiki.locale', 'en');
      const english = await mount(props);
      for (let index = 0; index < 4; index += 1) await settle();
      expect(english.container.querySelector('[data-session-live]')?.textContent).toBe('Running for 2d');

      localStorage.setItem('kiki.locale', 'zh');
      const chinese = await mount(props);
      for (let index = 0; index < 4; index += 1) await settle();
      expect(chinese.container.querySelector('[data-session-live]')?.textContent).toBe('已运行 2 天');
    } finally {
      localStorage.setItem('kiki.locale', 'en');
    }
  });
});

describe('Sidebar archive feedback', () => {
  /** The pending state a slow archive puts on one row, and nothing else. */
  function pendingRow(container: HTMLDivElement, id: string): HTMLElement | null {
    return container.querySelector(`[data-session-row="${id}"] [data-session-archiving]`);
  }

  async function openMenuFor(container: HTMLDivElement, id: string): Promise<HTMLElement> {
    const row = container.querySelector(`[data-session-row="${id}"] [data-session-title]`);
    if (row === null) throw new Error('session row not rendered');
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    const menu = container.querySelector<HTMLElement>('[data-session-menu]');
    if (menu === null) throw new Error('session menu did not open');
    return menu;
  }

  it('says the row is archiving at once, keeps it readable, and never asks twice', async () => {
    const target = { ...session('s-target'), title: 'Release notes' };
    const other = session('s-other');
    let release!: () => void;
    archiveSession.mockReturnValue(new Promise((resolve) => {
      release = () => { resolve(archived('s-target')); };
    }));
    const { container } = await mount({
      sessions: [target, other],
      sessionGroups: [{ key: 'today', label: 'Today', items: [target, other] }],
    });

    const menu = await openMenuFor(container, 's-target');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });

    // The menu is gone and the row is still exactly where it was.
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    expect(container.querySelector('[data-session-row="s-target"]')).not.toBeNull();
    // It says what it is doing, in the row's own second line.
    const pending = pendingRow(container, 's-target');
    expect(pending?.textContent).toBe('Archiving…');
    expect(pending?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-session-row="s-target"]')?.getAttribute('aria-busy')).toBe('true');
    // The title is still readable — the row did not become a placeholder.
    expect(container.querySelector('[data-session-row="s-target"] [data-session-title]')?.textContent).toContain('Release notes');
    // Only the conflicting management action goes quiet on that row.
    expect(container.querySelector<HTMLButtonElement>('[data-session-row="s-target"] [data-session-pin-toggle]')?.disabled).toBe(true);
    // Every other row is untouched and still fully operable.
    expect(container.querySelector('[data-session-row="s-other"]')?.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-session-row="s-other"] [data-session-pin-toggle]')?.disabled).toBe(false);

    // A second attempt on the same object is refused, not sent twice.
    const again = await openMenuFor(container, 's-target');
    await act(async () => { again.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    expect(archiveSession).toHaveBeenCalledTimes(1);

    await act(async () => { release(); await settle(); });
  });

  it('drops the row from the ordinary list on success and keeps it in the cache as archived', async () => {
    const target = session('s-gone');
    const other = session('s-stays');
    archiveSession.mockResolvedValue(archived('s-gone'));
    const { container, queryClient } = await mount({
      sessions: [target, other],
      sessionGroups: [{ key: 'today', label: 'Today', items: [target, other] }],
    }, browserHost, [target, other]);

    const menu = await openMenuFor(container, 's-gone');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    expect(pendingRow(container, 's-gone')).toBeNull();
    expect(container.querySelector('[data-session-row="s-stays"]')).not.toBeNull();
    // The authoritative answer is in the loaded pages, not just a refetch away.
    const cached = queryClient.getQueryData<{ pages: { items: { id: string; archived?: boolean }[] }[] }>(['sessions', 'cached']);
    expect(cached?.pages[0]?.items.find((entry) => entry.id === 's-gone')?.archived).toBe(true);
  });

  it('keeps the row, the title and its actions on a refusal, and says why in place', async () => {
    const target = { ...session('s-refused'), title: 'Kept thread' };
    archiveSession.mockRejectedValue(new Error('Archive refused: the thread has uncommitted drafts'));
    const { container } = await mount({
      sessions: [target],
      sessionGroups: [{ key: 'today', label: 'Today', items: [target] }],
    });

    const menu = await openMenuFor(container, 's-refused');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    // The row never left: a refusal is not a row that vanishes and returns.
    const row = container.querySelector('[data-session-row="s-refused"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-session-archive')).toBe('failed');
    expect(row?.getAttribute('aria-busy')).toBeNull();
    expect(row?.textContent).toContain('Kept thread');
    expect(row?.querySelector('[data-session-archive-error]')?.textContent)
      .toBe('Archive refused: the thread has uncommitted drafts');
    // Readable and actionable again — the next attempt can be made from here.
    expect(row?.querySelector<HTMLButtonElement>('[data-session-pin-toggle]')?.disabled).toBe(false);
    archiveSession.mockResolvedValue(archived('s-refused'));
    const retry = await openMenuFor(container, 's-refused');
    await act(async () => { retry.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();
    expect(archiveSession).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-session-archive-error]')).toBeNull();
  });

  it('asks the server to take the attached conversations, excluding only the promoted ones', async () => {
    // The explicit top-level preference for this space: s-promoted was promoted
    // by the user, and nothing else is exempt.
    configureSpaceStorage(null);
    localStorage.setItem('kiki.sidebar.topLevelThreads', JSON.stringify({ local: ['s-promoted'] }));
    const parent = session('s-parent');
    const promoted = session('s-promoted');
    archiveSession.mockResolvedValue(archived('s-parent'));
    const { container } = await mount({
      sessions: [parent, promoted],
      sessionGroups: [{ key: 'today', label: 'Today', items: [parent, promoted] }],
    });

    const menu = await openMenuFor(container, 's-parent');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    expect(archiveSession).toHaveBeenCalledWith('s-parent', { include_attached: true, exclude_session_ids: ['s-promoted'] });

    // Archiving the promoted row itself excludes nothing: it is the row being
    // archived, not a bystander, and its own children still go with it.
    archiveSession.mockClear();
    const own = await openMenuFor(container, 's-promoted');
    await act(async () => { own.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();
    expect(archiveSession).toHaveBeenCalledWith('s-promoted', { include_attached: true, exclude_session_ids: [] });
  });

  it('moves only the conversations the server confirmed, not the whole target set', async () => {
    const parent = session('s-parent');
    const child = { ...session('s-child'), metadata: { ...session('s-child').metadata, created_by_session_id: 's-parent' } };
    archiveSession.mockResolvedValue({ archived: false, outcomes: [{ id: 's-parent', ok: true }] });
    const { container, queryClient } = await mount({
      sessions: [parent, child],
      sessionGroups: [{ key: 'today', label: 'Today', items: [parent, child] }],
    }, browserHost, [parent, child]);

    const menu = await openMenuFor(container, 's-parent');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    const cached = queryClient.getQueryData<{ pages: { items: { id: string; archived?: boolean }[] }[] }>(['sessions', 'cached']);
    const archivedFlag = (id: string) => cached?.pages[0]?.items.find((entry) => entry.id === id)?.archived;
    expect(archivedFlag('s-parent')).toBe(true);
    // The child the server did not confirm is not declared archived by the GUI.
    expect(archivedFlag('s-child')).toBeUndefined();
  });

  it('archives successfully without overwriting restart PageResponse or array caches', async () => {
    const parent = session('s-parent');
    const other = session('s-other');
    const { container, queryClient } = await mount({
      sessions: [parent, other],
      sessionGroups: [{ key: 'today', label: 'Today', items: [parent, other] }],
    }, browserHost, [parent, other]);
    const restartPage = { items: [parent, other], has_more: true, busy_count: 1 };
    const arrayCache = [parent, other];
    await act(async () => {
      queryClient.setQueryData(['sessions', 'restart-confirm'], restartPage);
      queryClient.setQueryData(['sessions', 'array-view'], arrayCache);
    });

    const menu = await openMenuFor(container, 's-parent');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-session-archiving], [data-session-archive-error], [role="alert"]')).toBeNull();
    const paginated = queryClient.getQueryData<{ pages: { items: Session[] }[] }>(['sessions', 'cached']);
    expect(paginated?.pages[0]?.items.find((entry) => entry.id === parent.id)?.archived).toBe(true);
    expect(paginated?.pages[0]?.items.find((entry) => entry.id === other.id)?.archived).toBeUndefined();
    // Preserve records and non-paginated metadata; invalidation gives each
    // consumer its authoritative refresh instead of inventing a new shape.
    expect(queryClient.getQueryData(['sessions', 'restart-confirm'])).toBe(restartPage);
    expect(queryClient.getQueryData(['sessions', 'array-view'])).toBe(arrayCache);
    expect(queryClient.getQueryState(['sessions', 'restart-confirm'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['sessions', 'array-view'])?.isInvalidated).toBe(true);
  });

  it('shows a nested thread archive status without obscuring its title', async () => {
    const parent = session('s-parent');
    const child = { ...session('s-child'), title: 'Docs pass', metadata: { ...session('s-child').metadata, created_by_session_id: 's-parent' } };
    let release!: () => void;
    archiveSession.mockReturnValue(new Promise((resolve) => { release = () => { resolve(archived('s-child')); }; }));
    const { container } = await mount({
      sessions: [parent, child],
      sessionGroups: [{ key: 'today', label: 'Today', items: [parent, child] }],
    });

    const nested = container.querySelector('[data-session-threads="s-parent"] [data-session-row="s-child"]');
    expect(nested).not.toBeNull();
    const menu = await openMenuFor(container, 's-child');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    const status = nested?.querySelector('[data-session-archiving]');
    expect(status?.textContent).toContain('Archiving…');
    expect(status?.getAttribute('role')).toBe('status');
    expect(nested?.getAttribute('aria-busy')).toBe('true');
    expect(nested?.querySelector('[data-session-title]')?.textContent).toContain('Docs pass');

    await act(async () => { release(); await settle(); });
    expect(nested?.querySelector('[data-session-archiving]')).toBeNull();
  });

  it('keeps a refused nested thread in place with its reason', async () => {
    const parent = session('s-parent');
    const child = { ...session('s-child'), title: 'Docs pass', metadata: { ...session('s-child').metadata, created_by_session_id: 's-parent' } };
    archiveSession.mockRejectedValue(new Error('Archive refused: drafts were not saved'));
    // The re-read still finds the child: nothing was archived, so the reason
    // belongs on the row that is still standing.
    const { container } = await mount({
      sessions: [parent, child],
      sessionGroups: [{ key: 'today', label: 'Today', items: [parent, child] }],
    }, browserHost, [parent, child]);

    const menu = await openMenuFor(container, 's-child');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    const nested = container.querySelector('[data-session-threads="s-parent"] [data-session-row="s-child"]');
    const status = nested?.querySelector('[data-session-archive-error]');
    expect(status?.textContent).toContain('Archive refused: drafts were not saved');
    // The row is still there and still says what it is.
    expect(nested?.getAttribute('aria-busy')).toBeNull();
    expect(nested?.querySelector('[data-session-title]')?.textContent).toContain('Docs pass');
  });

  it('keeps an unfinished archive failure visible despite inactive caches', async () => {
    const root = { ...session('s-root'), title: 'Release coordination' };
    const child = { ...session('s-child'), title: 'Docs pass', metadata: { ...session('s-child').metadata, created_by_session_id: 's-root' } };
    archiveSession.mockRejectedValue(new Error('Some conversations could not be archived. Retry to finish archiving: s-child: drafts were not saved'));
    const { container, queryClient } = await mount({
      sessions: [root, child],
      sessionGroups: [{ key: 'today', label: 'Today', items: [root, child] }],
    }, browserHost, [root, child]);
    // An inactive old list and a non-paginated restart cache must not
    // suppress the stable failure banner or break the rejection handler.
    await act(async () => { queryClient.setQueryData(['sessions', 'restart-confirm'], [child]); });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const menu = await openMenuFor(container, 's-root');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    // The banner is said after the refreshed list has been read, so it
    // reflects what the server holds rather than what was on screen.
    await settle();

    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain('Some conversations could not be archived');
    expect(banner?.textContent).toContain('s-child');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(container.querySelector('[data-session-row="s-child"]')).not.toBeNull();
  });

  it.each([
    [new Error('Some conversations could not be archived. Retry to finish archiving: s-child: busy'), 'could not be archived'],
    [new ApiError({ code: 40001, msg: 'Archive refused: this conversation has uncommitted drafts', data: null }), 'Archive refused'],
  ])('refreshes the list behind an unfinished worktree archive and keeps the dialog: %s', async (failure, detail) => {
    const worktree = { worktree_id: 'wt_1', branch: 'feat/notes', source_root: 'C:/repo', base_ref: 'refs/heads/main' } as NonNullable<Session['worktree']>;
    const target = { ...session('s-wt'), title: 'Worktree thread', worktree } as Session & { worktree: NonNullable<Session['worktree']> };
    archiveSession.mockRejectedValue(failure);
    const { container, queryClient } = await mount({
      sessions: [target],
      sessionGroups: [{ key: 'today', label: 'Today', items: [target] }],
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const menu = await openMenuFor(container, 's-wt');
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();
    // The worktree dialog renders through a body portal, like every dialog here.
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-archive-confirm]');
    expect(confirm).not.toBeNull();

    const checkbox = document.body.querySelector<HTMLInputElement>('[data-archive-remove-worktree] input')!;
    await act(async () => { checkbox.click(); confirm!.click(); });
    await settle();
    expect(archiveSession).toHaveBeenCalledWith('s-wt', { include_attached: true, exclude_session_ids: [] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(document.body.querySelector('[data-archive-confirm]')).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(detail);
    expect(checkbox.checked).toBe(true);
    expect(confirm!.disabled).toBe(false);
  });
});

describe('Sidebar background tasks', () => {
  it('keeps background tasks off the row and lists them on the running word\'s hover', async () => {
    listTasks.mockResolvedValue({ items: [
      { id: 't1', session_id: 's-run', kind: 'bash', description: 'live viewer', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 't2', session_id: 's-run', kind: 'bash', description: 'rerun the suite', status: 'running', created_at: '2026-01-01T00:01:00.000Z' },
    ] });
    listPrompts.mockResolvedValue({ active: null, queued: [] });
    const running = { ...session('s-run'), busy: true, executing: true, main_turn_active: false };
    const { container } = await mount({ sessions: [running], sessionGroups: [{ key: 'today', label: 'Today', items: [running] }] });
    for (let index = 0; index < 4; index += 1) await settle();
    const row = container.querySelector<HTMLElement>('[data-session-row="s-run"]');
    expect(row?.querySelector('svg[data-icon="terminal"]')).toBeNull();
    expect(row?.textContent).not.toContain('background');
    expect(row?.querySelector('[data-session-live]')?.getAttribute('title'))
      .toBe(['2 background tasks running', '· live viewer', '· rerun the suite'].join('\n'));
  });
});

describe('Sidebar temporary conversations', () => {
  it('lists them in their own block above the history, without row actions', async () => {
    const saved = { ...session('s-saved'), updated_at: fixtureStamp(6) };
    listEphemeralSessions.mockResolvedValue({ items: [{ ...session('s-temp'), ephemeral: true }] });
    const { container } = await mount({
      sessions: [saved],
      nowMs: FIXTURE_NOW_MS,
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
  it('leads with the chosen destinations and folds the rest into More tools, in order', async () => {
    const { container } = await mount();
    const nav = container.querySelector('[data-primary-nav]');
    expect(nav?.getAttribute('aria-label')).toBe('Workspace tools');
    const labels = [...(nav?.querySelectorAll('button') ?? [])].map((button) => button.children[1]?.textContent);
    expect(labels).toEqual(['Memory', 'Personas', 'Activity', 'More tools']);
    expect(nav?.querySelector('[data-nav-personas]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-usage]')).not.toBeNull();
    // Memory is permanent, on or off: switched off the page is the turn-on guide.
    expect(nav?.querySelector('[data-nav-memory]')).not.toBeNull();
    // Scheduled tasks, capabilities and discovery start tucked under More tools.
    expect(nav?.querySelector('[data-nav-board]')).toBeNull();
    expect(nav?.querySelector('[data-nav-discover]')).toBeNull();
    expect(nav?.querySelector('[data-nav-cron]')).toBeNull();
    expect(nav?.querySelector('[data-nav-capabilities]')).toBeNull();

    const expandButton = nav?.querySelector<HTMLButtonElement>('[data-sidebar-secondary-toggle="expand"]');
    expect(expandButton).not.toBeNull();
    await act(async () => { expandButton?.click(); });

    const secondaryLabels = [...(nav?.querySelectorAll('[data-sidebar-secondary-nav] ul button') ?? [])].map((button) => button.children[1]?.textContent);
    expect(secondaryLabels).toEqual(['Scheduled tasks', 'Capabilities', 'Discover Kiki']);
    expect(nav?.querySelector('[data-nav-board]')).toBeNull();
    expect(nav?.querySelector('[data-nav-cron]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-capabilities]')).not.toBeNull();

    await settle();
    expect(nav?.querySelector('[data-request-governance-badge]')?.textContent).toBe('3 · +2');
  });

  it('places connection state on the top position bar and never renders a footer connection mark', async () => {
    const { container } = await mount();
    const footer = container.querySelector('[data-sidebar-footer]');
    expect(footer?.querySelector('[data-nav-settings]')).not.toBeNull();
    expect(footer?.querySelector('[data-connection-status]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Disconnect');

    connectionScope.ws = 'connecting';
    const dropped = await mount();
    expect(dropped.container.querySelector('[data-sidebar-footer] [data-connection-status]')).toBeNull();
    const subtitle = dropped.container.querySelector('[data-space-switcher-subtitle]');
    expect(subtitle?.textContent).toBe('Reconnecting…');
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
    const active = { ...session('active'), updated_at: fixtureStamp(6, 11) };
    const other = { ...session('other'), updated_at: fixtureStamp(6, 10) };
    const groups: SessionGroup[] = [
      { key: 'today', label: 'Today', items: [active, other] },
      { key: 'week', label: 'Past 7 days', items: [{ ...session('older'), updated_at: fixtureStamp(4) }] },
    ];
    const { container } = await mount({
      activeSessionId: 'active',
      sessions: [active, other, ...groups[1]!.items],
      nowMs: FIXTURE_NOW_MS,
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
    listPersonas.mockResolvedValue([{ id: 'xiao-you', name: '小柚', revision: 'revision-1', archived: false, homeSessionId: 'home_lin' }]);
    const active = { ...session('active'), updated_at: fixtureStamp(6, 11) };
    const { container } = await mount({
      activeSessionId: 'active',
      sessions: [active],
      workspaceOptions: [{ id: 'ws_a', name: 'EasyAgent', root: '/a', created_at: '', last_opened_at: '', pinned: false }],
      nowMs: FIXTURE_NOW_MS,
      sessionGroups: [{ key: 'today', label: 'Today', items: [active] }],
    });
    await settle();

    const personaGroup = container.querySelector<HTMLElement>('[data-sidebar-personas] [role="group"]');
    expect(personaGroup?.getAttribute('aria-label')).toBe('Personas');
    expect(personaGroup?.querySelector('[data-sidebar-persona-row="xiao-you"]')).not.toBeNull();
    // The name is the persona's stable daily address, never a fixed session.
    const name = personaGroup!.querySelector<HTMLButtonElement>('[data-sidebar-persona-row="xiao-you"] button')!;
    expect(name.textContent).toContain('小柚');

    const sessionList = container.querySelector<HTMLElement>('[data-session-list]')!;
    expect([...sessionList.querySelectorAll<HTMLElement>('[role="group"][aria-label]')].map((node) => node.getAttribute('aria-label')))
      .toEqual(['Personas', 'Today']);
    // Unified scroll: Personas sit inside the scrollable session list region above conversation groups.
    expect(sessionList.querySelector('[data-sidebar-personas]')).not.toBeNull();
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
    expect(document.querySelector('[data-view-menu]')).not.toBeNull();
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

  it('focuses the first option when View and Filter open as phone bottom sheets', async () => {
    const media = window as unknown as { matchMedia?: unknown };
    const originalMatchMedia = media.matchMedia;
    media.matchMedia = (query: string) => ({
      matches: query === '(pointer: coarse)' || query === '(pointer: coarse) and (max-width: 639px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      const { container } = await mount(listed());
      const viewSheet = await openViewMenu(container);
      expect(document.activeElement).toBe(viewSheet.querySelector('[data-group-by="time"]'));
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

      const filterSheet = await openFilterMenu(container);
      expect(document.activeElement).toBe(filterSheet.querySelector('[data-status-filter="idle"]'));
    } finally {
      if (originalMatchMedia === undefined) delete media.matchMedia;
      else media.matchMedia = originalMatchMedia;
    }
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
    // Only the states some session is in are offered: the one listed session is idle.
    expect([...menu.querySelectorAll('[data-status-filter]')].map((node) => node.getAttribute('data-status-filter')))
      .toEqual(['idle']);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-status-filter="idle"]')?.click();
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: ['idle'], workspaces: [], archived: 'hide' });
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
    expect(setWorkspacePinnedCatalog).toHaveBeenCalledWith(wsB.id, true);
  });

  it('hides the workspace section when the server reports none', async () => {
    const { container } = await mount({ ...listed(), workspaceOptions: [] });
    const menu = await openFilterMenu(container);
    expect(menu.querySelector('[data-workspace-filter]')).toBeNull();
    expect(menu.querySelector('[data-status-filter="idle"]')).not.toBeNull();
  });

  it('keeps a chosen status on offer after its last session left it, so it can be turned off', async () => {
    const onFiltersChange = vi.fn();
    const { container } = await mount({ ...listed(), filters: { status: ['running'], workspaces: [], archived: 'hide' }, onFiltersChange });
    const menu = await openFilterMenu(container);
    const running = menu.querySelector<HTMLButtonElement>('[data-status-filter="running"]');
    expect(running?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[data-status-filter="cleanup-pending"]')).toBeNull();
    await act(async () => { running?.click(); });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], workspaces: [], archived: 'hide' });
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

  it('layers Escape so that an open menu inside drawer consumes first, drawer closes second, and turn abort is 0', async () => {
    let sidebarOpen = true;
    const closeDrawer = () => { sidebarOpen = false; };
    const unregisterDrawer = registerOverlay('app-sidebar');

    const abortActive = vi.fn();
    const running = { ...createViewState('session-test'), busy: true, abortablePromptId: 'p-main' };

    // App drawer global Escape handler
    const appDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (anyOverlayOpen(['app-sidebar'])) return;
      event.preventDefault();
      closeDrawer();
    };

    // SessionView global Escape turn-abort handler
    const sessionViewKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleGlobalAbortOnEscape({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        overlayOpen: anyOverlayOpen(),
        terminalFocused: false,
        terminalOpen: false,
        railOpen: false,
        inFormField: false,
      })) return;
      if (canAbortActiveTurn(running)) {
        event.preventDefault();
        abortActive();
      }
    };

    window.addEventListener('keydown', appDrawerKeyDown);
    window.addEventListener('keydown', sessionViewKeyDown);

    try {
      const { container } = await mount({ ...listed(), workspaceOptions: [wsA, wsB] });
      const menu = await openFilterMenu(container);
      expect(document.querySelector('[data-filter-menu]')).not.toBeNull();
      expect(sidebarOpen).toBe(true);

      // First Escape: consumed by the AnchoredPopover surface ('sidebar-filter-menu').
      // It sets defaultPrevented, closes the menu, and appDrawerKeyDown yields because
      // anyOverlayOpen(['app-sidebar']) is true. The popover owns Escape on its surface,
      // so dispatch where focus sits (React flushes the synthetic handler inside act).
      await act(async () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });

      // Filter menu is closed, but drawer stays open!
      expect(document.querySelector('[data-filter-menu]')).toBeNull();
      expect(sidebarOpen).toBe(true);
      expect(abortActive).not.toHaveBeenCalled();

      // Second Escape: now no inner overlay is open. appDrawerKeyDown fires, preventsDefault,
      // and closes the drawer. SessionView global abort sees defaultPrevented / drawer overlay and yields.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });

      expect(sidebarOpen).toBe(false);
      expect(abortActive).not.toHaveBeenCalled();
    } finally {
      unregisterDrawer();
      window.removeEventListener('keydown', appDrawerKeyDown);
      window.removeEventListener('keydown', sessionViewKeyDown);
    }
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
    expect(document.querySelector('[data-join-room-dialog]')?.closest('[role="dialog"]')?.textContent).toContain('Add 2 threads');
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

  it('labels the same copy actions in Chinese and still copies the route and directory', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      const { container } = await mount(listed());
      const menu = await openSessionMenu(container);
      expect(menu.querySelector('[data-menu-item="copy-link"]')?.textContent).toBe('复制线程链接');
      expect(menu.querySelector('[data-menu-item="copy-path"]')?.textContent).toBe('复制工作目录');
      expect(menu.textContent).not.toContain('menu.copyThreadLink');
      expect(menu.textContent).not.toContain('menu.copyWorkingDirectory');
      await act(async () => {
        menu.querySelector<HTMLButtonElement>('[data-menu-item="copy-link"]')?.click();
      });
      expect(writeText).toHaveBeenCalledWith('/s/one');
      const again = await openSessionMenu(container);
      await act(async () => {
        again.querySelector<HTMLButtonElement>('[data-menu-item="copy-path"]')?.click();
      });
      expect(writeText).toHaveBeenCalledWith('C:/tmp');
    } finally {
      localStorage.setItem('kiki.locale', 'en');
    }
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

  it('adds the thread link to the open conversation, and is not offered with none open', async () => {
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
      await act(async () => { entry.click(); });
      expect(inserted).toEqual(['/s/session_other']);
      expect(container.querySelector('[data-session-menu]')).toBeNull();
      // The open conversation's own row has nothing to add to.
      const self = container.querySelector('[data-session-row="session_current"] [data-session-title]')!;
      await act(async () => { self.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
      expect(container.querySelector('[data-session-menu]')).not.toBeNull();
      expect(container.querySelector('[data-menu-item="add-to-conversation"]')).toBeNull();
    } finally {
      unsubscribe();
    }
    const none = await mount(listed());
    const menu = await openSessionMenu(none.container);
    expect(menu.querySelector('[data-menu-item="add-to-conversation"]')).toBeNull();
  });

  it('promotes branch and fork with seed submenus to level 1 and keeps export/compact/undo under More on desktop', async () => {
    const { container } = await mount(listed());
    const menu = await openSessionMenu(container);
    const keys = () => [...menu.querySelectorAll('[role="menuitem"]')].map((element) => element.getAttribute('data-menu-item'));
    expect(keys()).toEqual(['pin', 'toggle-mute', 'rename', 'private', 'branch', 'fork', 'copy-link', 'join-room', 'copy-path', 'archive', 'more']);

    const branchBtn = menu.querySelector<HTMLButtonElement>('[data-menu-item="branch"]')!;
    await act(async () => { branchBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    const branchSubmenu = menu.querySelector('[data-session-submenu="branch"]');
    expect([...(branchSubmenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((element) => element.getAttribute('data-menu-item')))
      .toEqual(['branch-fresh', 'branch-compact', 'branch-verbatim']);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(menu.querySelector('[data-session-submenu]')).toBeNull();
    expect(document.activeElement).toBe(branchBtn);

    const forkBtn = menu.querySelector<HTMLButtonElement>('[data-menu-item="fork"]')!;
    await act(async () => { forkBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    const forkSubmenu = menu.querySelector('[data-session-submenu="fork"]');
    expect([...(forkSubmenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((element) => element.getAttribute('data-menu-item')))
      .toEqual(['fork-verbatim', 'fork-fresh', 'fork-compact']);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(document.activeElement).toBe(forkBtn);

    const more = menu.querySelector<HTMLButtonElement>('[data-menu-item="more"]')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { more.click(); });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const submenu = menu.querySelector('[data-session-submenu="more"]');
    expect([...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((element) => element.getAttribute('data-menu-item')))
      .toEqual(['export', 'compact', 'undo']);
    // Focus moves in, and ← brings it back to More with the submenu closed.
    expect(submenu?.contains(document.activeElement)).toBe(true);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(menu.querySelector('[data-session-submenu]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('creates a branch or forks with the selected seed mode directly from the sidebar menu', async () => {
    const navigated: string[] = [];
    const { container } = await mount({
      ...listed(),
      guard: { dirty: false, rawNavigate: (to) => { navigated.push(typeof to === 'string' ? to : typeof to === 'number' ? String(to) : (to.pathname ?? '')); } },
    });
    const menu1 = await openSessionMenu(container);
    const branchBtn = menu1.querySelector<HTMLButtonElement>('[data-menu-item="branch"]')!;
    await act(async () => { branchBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await act(async () => {
      menu1.querySelector<HTMLButtonElement>('[data-menu-item="branch-compact"]')!.click();
    });
    await settle();
    expect(createBranchMock).toHaveBeenCalledWith('one', { seed: 'compact', tools_locked: false });
    expect(navigated.at(-1)).toBe('/s/one/agent/branch_1');

    const menu2 = await openSessionMenu(container);
    const forkBtn = menu2.querySelector<HTMLButtonElement>('[data-menu-item="fork"]')!;
    await act(async () => { forkBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await act(async () => {
      menu2.querySelector<HTMLButtonElement>('[data-menu-item="fork-fresh"]')!.click();
    });
    await settle();
    expect(forkSessionMock).toHaveBeenCalledWith('one', { seed: 'fresh' });
  });

  it('offers rooms only while thread communication is on', async () => {
    getConfig.mockResolvedValue({ thread_communication: { enabled: false } });
    const off = await mount(listed());
    await settle();
    const offMenu = await openSessionMenu(off.container);
    expect(offMenu.querySelector('[data-menu-item="join-room"]')).toBeNull();
    // Absent, not greyed out with an explanation.
    expect(offMenu.textContent).not.toContain('Thread communication is off');

    getConfig.mockResolvedValue({ thread_communication: { enabled: true } });
    const on = await mount(listed());
    await settle();
    const onMenu = await openSessionMenu(on.container);
    expect(onMenu.querySelector('[data-menu-item="join-room"]')).not.toBeNull();
  });
});

describe('Sidebar session menu keyboard focus', () => {
  const listed = (): { sessions: Session[]; sessionGroups: SessionGroup[] } => {
    const one = session('one');
    return { sessions: [one], sessionGroups: [{ key: 'today', label: 'Today', items: [one] }] };
  };

  /** Opens the row menu the way Shift+F10 would: a control in the row holds
   * focus, and the contextmenu bubbles up from the row's title. */
  async function openMenuFromFocusedRow(container: HTMLDivElement, id: string): Promise<{ menu: HTMLElement; origin: HTMLButtonElement }> {
    const origin = container.querySelector<HTMLButtonElement>(`[data-session-row="${id}"] [data-session-pin-toggle]`);
    if (origin === null) throw new Error('row control not rendered');
    await act(async () => { origin.focus(); });
    const title = container.querySelector(`[data-session-row="${id}"] [data-session-title]`);
    await act(async () => { title?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    const menu = container.querySelector<HTMLElement>('[data-session-menu]');
    if (menu === null) throw new Error('session menu did not open');
    return { menu, origin };
  }

  const menuItem = (menu: HTMLElement, text: string): HTMLButtonElement => {
    const found = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === text);
    if (found === undefined) throw new Error(`menu item ${text} not rendered`);
    return found;
  };

  const key = async (target: EventTarget, keyName: string): Promise<void> => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true })); });
  };

  it('moves focus to the first entry on open and cycles with arrows, Home and End', async () => {
    const { container } = await mount(listed());
    const { menu } = await openMenuFromFocusedRow(container, 'one');
    // Same enabled-item list the menu's own key handler walks.
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    await key(items[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    // Arrows wrap around both ends.
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu and hands focus back to the row control that had it', async () => {
    const { container } = await mount(listed());
    const { menu, origin } = await openMenuFromFocusedRow(container, 'one');
    expect(menu.contains(document.activeElement)).toBe(true);
    await key(window, 'Escape');
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it('an outside pointerdown closes the menu without pulling focus back', async () => {
    const threads = [session('one'), session('two')];
    const { container } = await mount({ sessions: threads, sessionGroups: [{ key: 'today', label: 'Today', items: threads }] });
    const { menu, origin } = await openMenuFromFocusedRow(container, 'one');
    expect(menu.contains(document.activeElement)).toBe(true);
    const elsewhere = container.querySelector('[data-session-row="two"] [data-session-pin-toggle]');
    if (elsewhere === null) throw new Error('second row control not rendered');
    await act(async () => { elsewhere.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    // The pointer's own target keeps its focus course; the opener is not re-focused.
    expect(document.activeElement).not.toBe(origin);
  });

  it('activating an entry closes the menu and hands focus back to the row control', async () => {
    const { container } = await mount(listed());
    const { menu, origin } = await openMenuFromFocusedRow(container, 'one');
    await act(async () => { menuItem(menu, 'Pin to top').click(); });
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it.each([
    ['refused', { accepted: false }, 'A manual compaction is already running or queued; wait for it to finish'],
    ['accepted', { accepted: true, status: 'queued', source: 'manual' }, null],
  ] as const)('reads the %s manual-compaction receipt like the session view', async (_case, receipt, duplicateText) => {
    clearToasts();
    compactSession.mockResolvedValueOnce(receipt);
    const { container } = await mount(listed());
    const { menu } = await openMenuFromFocusedRow(container, 'one');
    // The content actions sit one level down, under More.
    await act(async () => { menuItem(menu, 'More').click(); });
    await act(async () => { menuItem(menu, 'Compact context').click(); });
    expect(compactSession).toHaveBeenCalledWith('one', {});
    const notice = container.querySelector('[role="status"].border-success');
    if (duplicateText === null) {
      expect(notice?.textContent).toContain('Compaction requested');
      expect(getToasts()).toEqual([]);
    } else {
      expect(notice).toBeNull();
      expect(getToasts().map((toast) => [toast.tone, toast.text])).toEqual([['info', duplicateText]]);
    }
  });

  it('an entry that opens a dialog leaves focus with the dialog, not the row', async () => {
    const { container } = await mount(listed());
    const { menu, origin } = await openMenuFromFocusedRow(container, 'one');
    await act(async () => { menuItem(menu, 'Rename…').click(); });
    expect(container.querySelector('[data-session-menu]')).toBeNull();
    const input = document.body.querySelector<HTMLElement>('[data-autofocus]');
    expect(input).not.toBeNull();
    // The dialog's own autofocus lands after the menu's post-commit check, so
    // the row control is never re-focused on top of it.
    await settle();
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(origin);
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

  it('keeps promoted rows independent when thread activity also refreshes the parent aggregate', async () => {
    const stamp = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString();
    const parent = { ...session('root'), updated_at: stamp(4, 10), own_updated_at: stamp(4, 10) };
    const child = { ...thread('t1', 'root'), updated_at: stamp(4, 11), own_updated_at: stamp(4, 11) };
    const other = { ...session('other'), updated_at: stamp(4, 12), own_updated_at: stamp(4, 12) };
    const metadata = structuredClone(child.metadata);
    const testNowMs = new Date(2026, 9, 6, 12).getTime();
    const propsFor = (items: Session[], groupBy: 'none' | 'time' = 'none') => ({
      sessions: items, groupBy, nowMs: testNowMs,
      sessionGroups: groupConversationItems(mergeConversationItems(items, [], {}), {
        groupBy, workspaces: [], filters: DEFAULT_SESSION_LIST_FILTERS, nowMs: testNowMs,
      }),
    });
    const first = await mount(propsFor([parent, child, other]));
    const toggle = async (container: HTMLDivElement) => {
      await act(async () => { container.querySelector('[data-session-row="t1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-menu-item="thread-display"]')!.click(); });
    };
    const rows = (container: HTMLDivElement) => [...container.querySelectorAll('[data-session-row]')].map((row) => row.getAttribute('data-session-row'));
    expect(rows(first.container)).toEqual(['other', 'root', 't1']);
    await toggle(first.container);
    expect(rows(first.container)).toEqual(['other', 't1', 'root']);
    await act(async () => { first.root.unmount(); });

    const freshChild = { ...child, updated_at: stamp(6, 11), own_updated_at: stamp(6, 11) };
    const aggregateParent = { ...parent, updated_at: freshChild.updated_at };
    const second = await mount(propsFor([aggregateParent, freshChild, other]));
    expect(rows(second.container)).toEqual(['t1', 'other', 'root']);
    expect(second.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).toBeNull();
    expect(second.container.querySelector('[data-session-row="t1"] [data-session-relation-note]')).toBeNull();
    await act(async () => { second.root.unmount(); });
    const acrossTime = await mount(propsFor([aggregateParent, freshChild, other], 'time'));
    expect(acrossTime.container.querySelector('[data-session-group-key="today"] [data-session-row="t1"]')).not.toBeNull();
    expect(acrossTime.container.querySelector('[data-session-group-key="week"] [data-session-row="root"]')).not.toBeNull();
    await act(async () => { acrossTime.root.unmount(); });

    const freshParent = { ...aggregateParent, updated_at: stamp(6, 12), own_updated_at: stamp(6, 12) };
    const third = await mount(propsFor([freshParent, freshChild, other], 'time'));
    expect(rows(third.container)).toEqual(['root', 't1', 'other']);
    expect(third.container.querySelector('[data-session-group-key="today"] [data-session-row="t1"]')).not.toBeNull();
    expect(third.container.querySelector('[data-session-group-key="week"] [data-session-row="other"]')).not.toBeNull();
    await toggle(third.container);
    expect(third.container.querySelector('[data-session-threads="root"] [data-session-row="t1"]')).not.toBeNull();
    expect(child.metadata).toEqual(metadata);
    expect(freshChild.metadata).toEqual(metadata);
    await act(async () => { third.root.unmount(); });
  });

  it('promotes parent family when nested child recency updates, keeping top-level thread independent and respecting non-updated sort', async () => {
    const baseNow = new Date(2026, 9, 10, 12).getTime();
    const stamp = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString();

    // Family 1: p1 and c1 (day 8 = earlier in week, within 72h window)
    const p1 = { ...session('p1'), created_at: stamp(1), updated_at: stamp(8, 10), own_updated_at: stamp(8, 10) };
    const c1 = { ...thread('c1', 'p1'), created_at: stamp(2), updated_at: stamp(8, 11), own_updated_at: stamp(8, 11) };

    // Family 2: p2 and c2 (day 9 = yesterday)
    const p2 = { ...session('p2'), created_at: stamp(3), updated_at: stamp(9, 10), own_updated_at: stamp(9, 10) };
    const c2 = { ...thread('c2', 'p2'), created_at: stamp(4), updated_at: stamp(9, 11), own_updated_at: stamp(9, 11) };

    const rows = (container: HTMLDivElement) =>
      [...container.querySelectorAll('[data-session-row]')].map((row) => row.getAttribute('data-session-row'));

    const propsFor = (
      items: Session[],
      groupBy: 'none' | 'time' = 'time',
      sortBy: SessionSortOrder = 'updated-desc',
    ) => ({
      sessions: items,
      groupBy,
      sortBy,
      nowMs: baseNow,
      sessionGroups: groupConversationItems(
        mergeConversationItems(items, [], {}, sortBy),
        {
          groupBy,
          workspaces: [],
          filters: DEFAULT_SESSION_LIST_FILTERS,
          nowMs: baseNow,
          order: sortBy,
        },
      ),
    });

    // 1. Initial state: Family 2 (yesterday) precedes Family 1 (week)
    const view = await mount(propsFor([p1, c1, p2, c2]));
    expect(rows(view.container)).toEqual(['p2', 'c2', 'p1', 'c1']);
    expect(view.container.querySelector('[data-session-group-key="yesterday"] [data-session-row="p2"]')).not.toBeNull();
    expect(view.container.querySelector('[data-session-group-key="week"] [data-session-row="p1"]')).not.toBeNull();

    // 2. Child c1 updates to today (day 10, 14:00) without refreshing parent p1
    const freshC1 = { ...c1, updated_at: stamp(10, 14), own_updated_at: stamp(10, 14) };

    const rerender = async (newProps: SidebarOverrides) => {
      const { sessionGroups: rawGroups, initialEntries, ...rest } = newProps;
      const sessionGroups = (rawGroups ?? []).map((group) => ({
        ...group,
        items: group.items.map((item) => ('kind' in item ? item : threadItem(item))),
      }));
      await act(async () => {
        view.root.render(
          <QueryClientProvider client={view.queryClient}>
            <I18nProvider>
              <HostProvider host={browserHost}>
                <MemoryRouter initialEntries={initialEntries as string[] | undefined}>
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
                    sidebarMode="sessions"
                    {...rest}
                  />
                </MemoryRouter>
              </HostProvider>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
    };

    await rerender(propsFor([p1, freshC1, p2, c2]));

    // Parent p1 moves into 'today' bucket and precedes Family 2, with freshC1 nested inside it
    expect(rows(view.container)).toEqual(['p1', 'c1', 'p2', 'c2']);
    expect(view.container.querySelector('[data-session-group-key="today"] [data-session-row="p1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-session-threads="p1"] [data-session-row="c1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-session-group-key="yesterday"] [data-session-row="p2"]')).not.toBeNull();

    // Own timestamp is preserved on each session row: p1 keeps day 6, freshC1 has day 10
    const p1Time = view.container.querySelector('[data-session-row="p1"] [data-session-time]');
    const c1Time = view.container.querySelector('[data-session-row="c1"] [data-session-time]');
    expect(p1Time?.textContent).not.toEqual(c1Time?.textContent);

    // 3. Promote c1 to top level: explicit topLevel thread stays independent and does not pull p1
    await act(async () => {
      view.container.querySelector('[data-session-row="c1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-menu-item="thread-display"]')!.click();
    });

    // c1 is top-level in 'today', p1 drops back to 'week' behind Family 2 (yesterday)
    expect(view.container.querySelector('[data-session-threads="p1"] [data-session-row="c1"]')).toBeNull();
    expect(rows(view.container)).toEqual(['c1', 'p2', 'c2', 'p1']);
    expect(view.container.querySelector('[data-session-group-key="today"] [data-session-row="c1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-session-group-key="yesterday"] [data-session-row="p2"]')).not.toBeNull();
    expect(view.container.querySelector('[data-session-group-key="week"] [data-session-row="p1"]')).not.toBeNull();

    // 4. Non updated-desc sort order: recency projection is not applied
    // Toggle c1 back to nested first
    await act(async () => {
      view.container.querySelector('[data-session-row="c1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-menu-item="thread-display"]')!.click();
    });
    expect(view.container.querySelector('[data-session-threads="p1"] [data-session-row="c1"]')).not.toBeNull();

    // In created-desc order, p2 (created day 3) stays ahead of p1 (created day 1) despite c1 recent activity
    await rerender(propsFor([p1, freshC1, p2, c2], 'none', 'created-desc'));
    expect(rows(view.container)).toEqual(['p2', 'c2', 'p1', 'c1']);

    await act(async () => { view.root.unmount(); });
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
    expect(first.container.querySelector('[data-session-row="t1"] [data-session-relation-note]')).toBeNull();
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
    expect(container.querySelectorAll('[data-session-threads="root"] [data-session-row]')).toHaveLength(2);
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

  it('keeps an orphan top-level without rendering a from-parent subtitle in the row', async () => {
    const orphan = thread('orphan', 'missing');
    const { container } = await mount({ sessions: [orphan], sessionGroups: [group('today', [orphan])] });
    expect(container.querySelector('[data-session-row="orphan"] [data-session-relation-note]')).toBeNull();
    expect(orphan.metadata['created_by_session_id']).toBe('missing');
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

  it('distinguishes needs_you, working, and unread row dots while drawing nothing for a caught-up row', async () => {
    resetSessionSeen();
    const needsYou = { ...session('blocked_dot'), pending_interaction: 'approval' as const, last_seq: 2 };
    const running = { ...session('run'), busy: true, executing: true, last_seq: 2 };
    const unread = { ...session('unread_done'), last_seq: 2 };
    const read = { ...session('read'), last_seq: 2 };
    markSessionSeen('read', 2);
    const items = [needsYou, running, unread, read];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    expect(container.querySelector('[data-session-row="blocked_dot"] [data-sidebar-dot="needs_you"] span')?.className).toContain('bg-attention');
    expect(container.querySelector('[data-session-row="run"] [data-sidebar-dot="working"] span')?.className).toContain('status-dot-busy');
    expect(container.querySelector('[data-session-row="unread_done"] [data-sidebar-dot="unread"] span')?.className).toContain('border-ink-soft');
    expect(container.querySelector('[data-session-row="read"] [data-sidebar-signal]')?.getAttribute('data-sidebar-signal')).toBe('normal');
    expect(container.querySelector('[data-session-row="read"] [data-sidebar-dot]')).toBeNull();
    // The header's running count is the one mark allowed to breathe.
    expect(container.querySelector('[data-activity-summary] [data-life]')?.hasAttribute('data-life-still')).toBe(false);
  });

  it('says an unseen failure in words and uses the 2-state neutral dot (no red square shape)', async () => {
    resetSessionSeen();
    const failed = { ...session('fail'), last_turn_reason: 'failed' as const, last_seq: 4 };
    const stopped = { ...session('stop'), last_turn_reason: 'cancelled' as const, last_seq: 4 };
    const items = [failed, stopped];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    expect(container.querySelector('[data-session-row="fail"] [data-session-failed]')?.textContent).toBe('Failed');
    expect(container.querySelector('[data-session-row="stop"] [data-session-failed]')?.textContent).toBe('Stopped');
    const mark = container.querySelector('[data-session-row="fail"] [data-sidebar-signal="active"]');
    expect(mark).not.toBeNull();
  });

  it('sanitizes machine tool-call envelopes in titles while preserving legitimate human titles with < or ReadMediaFile', async () => {
    const items = [
      { ...session('s_tool'), title: '<tool_call name="ReadMediaFile" path="case2.png" />' },
      { ...session('s_human_lt'), title: '1 < 2 比较与边界测试' },
      { ...session('s_human_tool'), title: 'ReadMediaFile 转写 case2 录音' },
    ];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }] });
    const toolText = container.querySelector('[data-session-row="s_tool"]')?.textContent ?? '';
    expect(toolText).not.toContain('<tool_call');
    expect(container.querySelector('[data-session-row="s_human_lt"]')?.textContent).toContain('1 < 2 比较与边界测试');
    expect(container.querySelector('[data-session-row="s_human_tool"]')?.textContent).toContain('ReadMediaFile 转写 case2 录音');
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
    const { container } = await mount({
      initialEntries: ['/cron'],
      navBadges: { cron: { count: 2, label: '2 stale' } },
    });
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
    expect(setWorkspacePinnedCatalog).toHaveBeenCalledWith('ws_b', true);
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

  it('starts a draft in the row workspace, not the open session, and keeps the fold', async () => {
    const onNewSession = vi.fn();
    const rawNavigate = vi.fn();
    const seat = { current: null as ReturnType<typeof useDirtyGuardState> | null };
    const orphan = { ...session('orphan'), workspace_id: 'missing' };
    const { container } = await mount({
      ...grouped(),
      activeSessionId: 'b1',
      onNewSession,
      sessions: [inA, inB, orphan],
      sessionGroups: [
        { key: 'pinned', label: 'Pinned', items: [inB] },
        { key: 'ws_a', label: 'alpha', items: [inA] },
        { key: 'ws_b', label: 'beta', items: [inB] },
        { key: WORKSPACE_UNGROUPED_KEY, label: 'Ungrouped', items: [orphan] },
      ],
      guard: { dirty: true, rawNavigate, seat },
    });
    const plusA = container.querySelector<HTMLButtonElement>('[data-session-group-new="ws_a"]')!;
    const plusB = container.querySelector<HTMLButtonElement>('[data-session-group-new="ws_b"]')!;
    expect(plusA.closest('[data-session-group]')).toBeNull();
    expect(plusA.getAttribute('aria-label')).toBe('New session in alpha');
    expect(plusA.className).toContain('group-hover/ws:opacity-100');
    expect(plusA.className).toContain('group-focus-within/ws:opacity-100');
    expect(plusA.className).toContain('[@media(hover:none)]:opacity-100');
    expect(plusA.className).toContain('focus-visible:opacity-100');
    expect(container.querySelector('[data-session-group-new="pinned"]')).toBeNull();
    expect(container.querySelector(`[data-session-group-new="${WORKSPACE_UNGROUPED_KEY}"]`)).toBeNull();
    expect(container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { plusA.click(); });
    expect(onNewSession).not.toHaveBeenCalled();
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(seat.current?.pending).toBe(true);
    expect(container.querySelector('[data-session-row="a1"]')).not.toBeNull();
    expect(container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { await seat.current?.confirm(); });
    expect(rawNavigate).toHaveBeenCalledExactlyOnceWith('/new?workspace=ws_a', undefined);
    expect(container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('true');

    rawNavigate.mockClear();
    await act(async () => { plusB.click(); });
    expect(rawNavigate).not.toHaveBeenCalled();
    await act(async () => { seat.current?.cancel(); });
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-session-row="b1"]')).not.toBeNull();
  });

  it('uses the same new-session path immediately when nothing is unsaved', async () => {
    const onNewSession = vi.fn();
    const rawNavigate = vi.fn();
    const { container } = await mount({
      ...grouped(),
      activeSessionId: 'b1',
      onNewSession,
      guard: { dirty: false, rawNavigate },
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-session-group-new="ws_a"]')!.click();
    });
    expect(rawNavigate).toHaveBeenCalledExactlyOnceWith('/new?workspace=ws_a', undefined);
    expect(onNewSession).not.toHaveBeenCalled();
    expect(container.querySelector('[data-session-group="ws_a"]')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-new-session]')!.click(); });
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(rawNavigate).toHaveBeenCalledOnce();
  });

  it('does not offer a workspace plus outside the workspace view', async () => {
    const { container } = await mount({
      ...grouped(),
      groupBy: 'time',
      sessionGroups: [{ key: 'today', label: 'Today', items: [inA, inB] }],
    });
    expect(container.querySelector('[data-session-group-new]')).toBeNull();
    expect(container.querySelector('[data-new-session]')).not.toBeNull();
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
    expect(container.querySelectorAll('[data-session-group-key="pinned"] [data-session-row]')).toHaveLength(10);
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
      host: 'xiao-you',
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

  it('shares the named-workspace location rule with session rows', async () => {
    const pinned = { ...session('pinned'), metadata: { cwd: 'C:/work/pinned', [SESSION_PIN_META_KEY]: true } as Session['metadata'] };
    const named = { ...session('named'), metadata: { cwd: 'C:/work/named' } as Session['metadata'] };
    const child = { ...session('child'), metadata: { cwd: 'C:/work/named', created_by_session_id: 'named' } as Session['metadata'] };
    const ungrouped = { ...session('ungrouped'), workspace_id: 'missing', metadata: { cwd: 'C:/orphan/session' } as Session['metadata'] };
    const pinnedRoom = roomSummary({ id: 'pinned-room', pinned: true });
    const namedRoom = roomSummary({ id: 'named-room' });
    const ungroupedRoom = roomSummary({ id: 'ungrouped-room', workspace: 'C:/orphan/room' });
    const { container } = await mount({
      sessions: [pinned, named, child, ungrouped],
      rooms: [pinnedRoom, namedRoom, ungroupedRoom],
      groupBy: 'workspace',
      workspaceOptions: [workspace('ws_test', 'app')],
      sessionGroups: [
        { key: 'pinned', label: 'Pinned', items: [pinned, roomItem(pinnedRoom)] },
        { key: 'ws_test', label: 'app', items: [named, child, roomItem(namedRoom)] },
        { key: WORKSPACE_UNGROUPED_KEY, label: 'Ungrouped', items: [ungrouped, roomItem(ungroupedRoom)] },
      ],
    });
    const sessionLocation = (group: string, id: string) => container.querySelector(`[data-session-group-key="${group}"] [data-session-row="${id}"] [data-session-location]`);
    const roomLocation = (group: string, id: string) => container.querySelector(`[data-session-group-key="${group}"] [data-room-row="${id}"] [data-room-location]`);
    expect(sessionLocation('pinned', 'pinned')?.textContent).toBe('…/work/pinned');
    expect(roomLocation('pinned', 'pinned-room')?.textContent).toBe('app');
    expect(sessionLocation(WORKSPACE_UNGROUPED_KEY, 'ungrouped')?.textContent).toBe('…/orphan/session');
    expect(roomLocation(WORKSPACE_UNGROUPED_KEY, 'ungrouped-room')?.textContent).toBe('…/orphan/room');
    expect(sessionLocation('ws_test', 'named')).toBeNull();
    expect(roomLocation('ws_test', 'named-room')).toBeNull();
    const nested = container.querySelector('[data-session-group-key="ws_test"][data-session-node="thread"] [data-session-row="child"]');
    expect(nested).not.toBeNull();
    expect(nested?.querySelector('[data-session-location]')).toBeNull();
  });

  it('carries the thread row states: unread, running, and needs you (approval and budget)', async () => {
    const unread = roomSummary({ id: 'room_unread', lastSeq: 3 });
    const running = roomSummary({ id: 'room_running', busy: true });
    const approval = roomSummary({ id: 'room_approval', needsYou: true, pendingInteraction: 'approval' });
    const budget = roomSummary({ id: 'room_budget', needsYou: true, pendingInteraction: 'none' });
    const { container } = await mount({
      rooms: [unread, running, approval, budget],
      workspaceOptions: [workspace('ws_test', 'app')],
      sessionGroups: [{ key: 'today', label: 'Today', items: [roomItem(unread), roomItem(running), roomItem(approval), roomItem(budget)] }],
    });
    expect(container.querySelector('[data-room-row="room_unread"]')?.getAttribute('data-room-row-state')).toBe('unread');
    const runningRow = container.querySelector('[data-room-row="room_running"]');
    expect(runningRow?.getAttribute('data-room-row-state')).toBe('running');
    expect(runningRow?.querySelector('[data-room-live]')?.textContent).toBe('Running');
    expect(runningRow?.querySelector('[data-room-location]')?.textContent).toBe('app');
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

  it('opens with focus on the first entry and Escape hands it back to the row control', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1' })));
    // A control in the row holds focus, the way Shift+F10 would open the menu.
    const origin = container.querySelector<HTMLButtonElement>('[data-room-pin-toggle]');
    if (origin === null) throw new Error('room row control not rendered');
    await act(async () => { origin.focus(); });
    const menu = await openRoomMenu(container);
    const first = menu.querySelector<HTMLButtonElement>('button:not([disabled])');
    if (first === null) throw new Error('room menu has no enabled entry');
    expect(document.activeElement).toBe(first);
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(first);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(container.querySelector('[data-room-menu]')).toBeNull();
    expect(document.activeElement).toBe(origin);
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

  it('renames inline on the row, with the room heading as the field label', async () => {
    roomRest.get.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    roomRest.update.mockResolvedValue(roomDocument(roomSummary({ id: 'room_1' })));
    const { container } = await mount(listedRoom(roomSummary({ id: 'room_1', title: '0.31 发布' })));
    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="rename"]')!.click(); });
    // The row-local editor portals to <body> over the row's title.
    const editor = document.body.querySelector('[data-rename-editor="room_1"]');
    expect(editor).not.toBeNull();
    const input = editor!.querySelector<HTMLInputElement>('[data-rename-input]')!;
    expect(input.getAttribute('aria-label')).toBe('Rename room');
    expect(input.value).toBe('0.31 发布');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '0.32 发布');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The Enter that commits an IME candidate (Safari: keyCode 229 after
    // compositionend; Chromium: isComposing) and the Escape that cancels one
    // belong to the IME: the half-typed title is neither saved nor dropped.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, keyCode: 229 }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, keyCode: 229 }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }));
    });
    await settle();
    expect(roomRest.update).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-rename-editor="room_1"]')).not.toBeNull();
    expect(input.value).toBe('0.32 发布');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
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

  it('says a slow room archive is archiving, in the same words a thread uses', async () => {
    const room = roomSummary({ id: 'room_1', title: 'Release room' });
    roomRest.get.mockResolvedValue(roomDocument(room, false));
    let release!: () => void;
    roomRest.update.mockReturnValue(new Promise((resolve) => {
      release = () => { resolve(roomDocument({ ...room, archived: true })); };
    }));
    const { container } = await mount(listedRoom(room));

    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });

    expect(container.querySelector('[data-room-menu]')).toBeNull();
    const row = container.querySelector('[data-room-row="room_1"]');
    expect(row).not.toBeNull();
    // The room's own copy, in its own second line, identical to a thread's.
    const pending = row?.querySelector('[data-room-archiving]');
    expect(pending?.textContent).toBe('Archiving…');
    expect(pending?.getAttribute('role')).toBe('status');
    expect(row?.getAttribute('aria-busy')).toBe('true');
    expect(row?.querySelector('[data-room-title]')?.textContent).toContain('Release room');
    // The archive entry itself is disabled for as long as it is in flight.
    const reopen = await openRoomMenu(container);
    expect(reopen.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')?.disabled).toBe(true);
    await act(async () => { reopen.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    expect(roomRest.update).toHaveBeenCalledTimes(1);

    await act(async () => { release(); await settle(); });
    expect(container.querySelector('[data-room-archiving]')).toBeNull();
  });

  it('keeps a refused room in place, with the reason, and lets the archive be retried', async () => {
    const room = roomSummary({ id: 'room_1', title: 'Release room' });
    roomRest.get.mockResolvedValue(roomDocument(room, false));
    roomRest.update.mockRejectedValueOnce(new Error('Room archive refused: members are still active'));
    const { container } = await mount(listedRoom(room));

    const menu = await openRoomMenu(container);
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();

    const row = container.querySelector('[data-room-row="room_1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-room-archive')).toBe('failed');
    expect(row?.textContent).toContain('Release room');
    expect(row?.querySelector('[data-room-archive-error]')?.textContent)
      .toBe('Room archive refused: members are still active');
    roomRest.update.mockResolvedValueOnce(roomDocument({ ...room, archived: true }));
    const retry = await openRoomMenu(container);
    await act(async () => { retry.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!.click(); });
    await settle();
    expect(roomRest.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-room-archive-error]')).toBeNull();
  });

  it('shows the rooms fetch failure instead of an empty list', async () => {
    const { container } = await mount({
      roomsQuery: { isError: true },
      sessionGroups: [{ key: 'today', label: 'Today', items: [session('one')] }],
    });
    expect(container.querySelector('[data-rooms-error]')?.textContent).toContain('Could not load rooms');
  });
});

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

describe('collapsed icon rail', () => {
  // The two breakpoints the sidebar reads: desktop starts at 768px, the
  // automatic collapse runs until 1280px. A stored sidebarCollapsed override
  // wins over both.
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
    for (const hook of ['memory', 'personas', 'usage']) {
      const button = container.querySelector(`[data-nav-${hook}]`);
      expect(button).not.toBeNull();
      expect(button?.getAttribute('title')).not.toBe('');
    }
    // Secondary destinations fold behind the More trigger in the collapsed rail.
    expect(container.querySelector('[data-nav-cron]')).toBeNull();
    expect(container.querySelector('[data-nav-capabilities]')).toBeNull();
    const moreBtn = container.querySelector<HTMLButtonElement>('[data-sidebar-rail-more]');
    expect(moreBtn).not.toBeNull();
    await act(async () => { moreBtn!.click(); });
    expect(document.body.querySelector('[data-sidebar-rail-more-menu]')).not.toBeNull();
    expect(container.querySelector('[data-nav-settings]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="expand"]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-toggle="collapse"]')).toBeNull();
    await settle();
    expect(aside?.querySelector('[data-nav-usage] [data-request-governance-badge]')?.textContent).toBe('3+2');
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
  const one = { ...session('one'), title: 'A very long session title '.repeat(10), updated_at: fixtureStamp(6, 10) };
  const two = { ...session('two'), title: 'Another long title '.repeat(10), updated_at: fixtureStamp(4, 10) };
  const { container } = await mount({ sessions: [one, two], groupBy: 'time', nowMs: FIXTURE_NOW_MS, sessionGroups: [
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

describe('sidebar secondary navigation', () => {
  it('keeps secondary navigation compact and folded by default (when preference unset) while pinned items stay visible', async () => {
    await act(async () => {
      // Folded by default. Written explicitly because the layout store keeps
      // an in-memory snapshot: an earlier test's expand survives a bare
      // localStorage clear, so the "unset" premise has to be re-published.
      writeLayoutPreferences({ sidebarCollapsed: false, sidebarNavSectionCollapsed: true });
    });
    const { container } = await mount();

    for (const hook of ['memory', 'personas', 'usage']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).not.toBeNull();
    }

    for (const hook of ['cron', 'capabilities', 'discover']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).toBeNull();
    }

    const toggle = container.querySelector<HTMLButtonElement>('[data-sidebar-secondary-toggle="expand"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toMatch(/More tools|更多工具/);
  });

  it('honors explicit false for sidebarNavSectionCollapsed', async () => {
    await act(async () => {
      writeLayoutPreferences({ sidebarCollapsed: false, sidebarNavSectionCollapsed: false });
    });
    const { container } = await mount();

    for (const hook of ['memory', 'personas', 'usage', 'cron', 'capabilities', 'discover']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).not.toBeNull();
    }

    const toggle = container.querySelector<HTMLButtonElement>('[data-sidebar-secondary-toggle="collapse"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('expands and collapses secondary items and persists choice to layoutPrefs', async () => {
    await act(async () => {
      writeLayoutPreferences({ sidebarCollapsed: false, sidebarNavSectionCollapsed: true });
    });
    const { container } = await mount();

    const expandBtn = container.querySelector<HTMLButtonElement>('[data-sidebar-secondary-toggle="expand"]');
    expect(expandBtn).not.toBeNull();
    await act(async () => {
      expandBtn?.click();
    });

    expect(readLayoutPreferences().sidebarNavSectionCollapsed).toBe(false);

    for (const hook of ['cron', 'capabilities']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).not.toBeNull();
    }

    const collapseBtn = container.querySelector<HTMLButtonElement>('[data-sidebar-secondary-toggle="collapse"]');
    expect(collapseBtn).not.toBeNull();
    expect(collapseBtn?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      collapseBtn?.click();
    });

    expect(readLayoutPreferences().sidebarNavSectionCollapsed).toBe(true);
    for (const hook of ['cron', 'capabilities']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).toBeNull();
    }
  });

  it('keeps the active secondary item visible even when the fold is collapsed', async () => {
    await act(async () => {
      writeLayoutPreferences({ sidebarCollapsed: false, sidebarNavSectionCollapsed: true });
    });
    const { container } = await mount({ initialEntries: ['/cron'] });

    expect(container.querySelector('[data-nav-board]')).toBeNull();
    const cronBtn = container.querySelector<HTMLButtonElement>('[data-primary-nav] [data-nav-cron]');
    expect(cronBtn).not.toBeNull();
    expect(cronBtn?.getAttribute('aria-current')).toBe('page');

    expect(container.querySelector('[data-primary-nav] [data-nav-capabilities]')).toBeNull();
    expect(container.querySelector('[data-primary-nav] [data-nav-discover]')).toBeNull();

    expect(container.querySelector('[data-sidebar-secondary-toggle="expand"]')).not.toBeNull();
  });

  it('aggregates secondary badges on the collapsed toggle button', async () => {
    await act(async () => {
      writeLayoutPreferences({ sidebarCollapsed: false, sidebarNavSectionCollapsed: true });
    });
    const { container } = await mount({
      navBadges: {
        cron: { count: 3, label: '3 stale tasks' },
      },
    });

    const badge = container.querySelector('[data-secondary-badges-count]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('3');
  });

  it('toggles pinnedNavItems via view menu, persisting choice and updating primary nav', async () => {
    await act(async () => {
      writeLayoutPreferences({
        sidebarCollapsed: false,
        sidebarNavSectionCollapsed: true,
        pinnedNavItems: DEFAULT_PINNED_NAV_ITEMS,
      });
    });
    const { container } = await mount();

    expect(container.querySelector('[data-nav-board]')).toBeNull();
    expect(container.querySelector('[data-primary-nav] [data-nav-cron]')).toBeNull();
    expect(container.querySelector('[data-primary-nav] [data-nav-memory]')).not.toBeNull();

    const viewMenuBtn = container.querySelector<HTMLButtonElement>('[data-view-menu-toggle]');
    expect(viewMenuBtn).not.toBeNull();
    await act(async () => {
      viewMenuBtn?.click();
    });

    expect(document.querySelector('[data-nav-item-toggle="board"]')).toBeNull();
    const cronToggle = document.querySelector<HTMLButtonElement>('[data-nav-item-toggle="cron"]');
    expect(cronToggle).not.toBeNull();
    expect(cronToggle?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      cronToggle?.click();
    });

    expect(readLayoutPreferences().pinnedNavItems).toContain('cron');
    expect(readLayoutPreferences().pinnedNavItems).not.toContain('board');
    expect(cronToggle?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-primary-nav] [data-nav-cron]')).not.toBeNull();

    // Negative: unpin 'memory'
    const memoryToggle = document.querySelector<HTMLButtonElement>('[data-nav-item-toggle="memory"]');
    expect(memoryToggle).not.toBeNull();
    expect(memoryToggle?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      memoryToggle?.click();
    });

    expect(readLayoutPreferences().pinnedNavItems).not.toContain('memory');
    expect(memoryToggle?.getAttribute('aria-checked')).toBe('false');
    // Memory is now secondary and the fold is collapsed, so it is hidden from the primary nav
    expect(container.querySelector('[data-primary-nav] [data-nav-memory]')).toBeNull();
  });

  it('does not double count active secondary item badges in the secondary badges aggregate', async () => {
    await act(async () => {
      writeLayoutPreferences({
        sidebarCollapsed: false,
        sidebarNavSectionCollapsed: true,
        pinnedNavItems: DEFAULT_PINNED_NAV_ITEMS,
      });
    });
    const { container } = await mount({
      initialEntries: ['/cron'],
      navBadges: {
        cron: { count: 3, label: '3 tasks' },
        capabilities: { count: 2, label: '2 grants' },
      },
    });

    const cronNav = container.querySelector('[data-primary-nav] [data-nav-cron]');
    expect(cronNav).not.toBeNull();
    expect(cronNav?.textContent).toContain('3');

    const secondaryBadge = container.querySelector('[data-secondary-badges-count]');
    expect(secondaryBadge).not.toBeNull();
    expect(secondaryBadge?.textContent).toBe('2');
  });
});

/** A phone: touch, and narrower than 640px (the drawer stage). */
function stubPhone(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)'
      || query === '(pointer: coarse) and (max-width: 639px)'
      || query === '(max-width: 767px)'
      || query === '(max-width: 1279px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('sidebar on a phone', () => {
  beforeEach(() => {
    stubPhone();
    resetLayoutPreferencesForTests();
  });

  it('pins no tools until this device saves a choice, then shows the saved one', async () => {
    const { container } = await mount();
    const nav = container.querySelector('[data-primary-nav]');
    for (const hook of ['memory', 'personas', 'usage', 'cron', 'capabilities', 'discover']) {
      expect(nav?.querySelector(`[data-nav-${hook}]`)).toBeNull();
    }
    expect(nav?.querySelector('[data-sidebar-secondary-toggle="expand"]')).not.toBeNull();

    // The view menu mirrors that, and the first pin saves just that tool.
    // It comes up as a bottom sheet, like the filter and row menus.
    const view = await openViewMenu(container);
    expect(view.classList.contains('kiki-action-sheet-layer')).toBe(true);
    expect(document.querySelector('[data-nav-item-toggle="memory"]')?.getAttribute('aria-checked')).toBe('false');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-nav-item-toggle="usage"]')?.click(); });
    expect(readLayoutPreferences().pinnedNavItems).toEqual(['usage']);
    expect(nav?.querySelector('[data-nav-usage]')).not.toBeNull();
    expect(nav?.querySelector('[data-nav-memory]')).toBeNull();
  });

  it('opens the row menu as a bottom sheet with level-1 branch and fork stepping into seed choices', async () => {
    const other = session('other');
    const current = session('current');
    const items = [other, current];
    const { container } = await mount({ sessions: items, sessionGroups: [{ key: 'today', label: 'Today', items }], activeSessionId: 'current' });
    const trigger = container.querySelector<HTMLButtonElement>('[data-session-row="other"] button[aria-label="Session actions for other"]');
    await act(async () => { trigger!.click(); });
    const sheet = document.querySelector<HTMLElement>('[data-session-menu]');
    expect(sheet?.classList.contains('kiki-action-sheet-layer')).toBe(true);
    expect([...sheet!.querySelectorAll('[role="menuitem"]')].map((element) => element.getAttribute('data-menu-item')))
      .toEqual(['pin', 'toggle-mute', 'rename', 'private', 'branch', 'fork', 'copy-link', 'add-to-conversation', 'join-room', 'copy-path', 'archive']);
    await act(async () => { sheet!.querySelector<HTMLButtonElement>('[data-menu-item="fork"]')!.click(); });
    expect([...sheet!.querySelectorAll('[role="menuitem"]')].map((element) => element.getAttribute('data-menu-item')))
      .toEqual(['seed-back', 'fork-verbatim', 'fork-fresh', 'fork-compact']);
    await act(async () => { sheet!.querySelector<HTMLButtonElement>('[data-menu-item="fork-compact"]')!.click(); });
    await settle();
    expect(forkSessionMock).toHaveBeenCalledWith('other', { seed: 'compact' });
  });

  it('keeps a choice saved before, even when it is the desktop default', async () => {
    writeLayoutPreferences({ pinnedNavItems: ['memory', 'personas', 'usage'] });
    const { container } = await mount();
    for (const hook of ['memory', 'personas', 'usage']) {
      expect(container.querySelector(`[data-primary-nav] [data-nav-${hook}]`)).not.toBeNull();
    }
  });

  it('polls nothing for a closed drawer and reads again once it is open', async () => {
    const running = { ...session('s-busy'), busy: true, executing: true, main_turn_active: true };
    const props = { sessions: [running], sessionGroups: [{ key: 'today', label: 'Today', items: [running] }] };
    writeLayoutPreferences({ pinnedNavItems: ['usage'] });
    listPrompts.mockClear();
    listTasks.mockClear();

    // inert: the drawer is closed (off-screen) — no usage badge poll, no
    // temporary-conversation poll, no per-session prompt/task reads.
    const closed = await mount({ ...props, inert: true });
    for (let index = 0; index < 3; index += 1) await settle();
    expect(closed.container.querySelector('[data-primary-nav] [data-nav-usage]')).not.toBeNull();
    expect(closed.container.querySelector('[data-request-governance-badge]')).toBeNull();
    expect(closed.queryClient.getQueryCache().find({ queryKey: ['request-governance'] })).toBeUndefined();
    expect(listEphemeralSessions).not.toHaveBeenCalled();
    expect(listPrompts).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();

    const open = await mount({ ...props, inert: false });
    for (let index = 0; index < 3; index += 1) await settle();
    expect(open.container.querySelector('[data-request-governance-badge]')?.textContent).toBe('3 · +2');
    expect(listEphemeralSessions).toHaveBeenCalled();
    expect(listPrompts).toHaveBeenCalledWith('s-busy', { observe: true });
    expect(listTasks).toHaveBeenCalled();
  });

  it('requests no plugin GUI slots across session switches while the drawer is closed, then reads once on open', async () => {
    connectionScope.brokerConfig = { url: 'http://127.0.0.1:9999', token: 'tok' };
    const slotRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/plugins/gui-slots')) {
        slotRequests.push(url);
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              slots: [
                {
                  slot: 'sidebar-panel',
                  pluginId: 'notes',
                  id: 'board',
                  title: { default: 'Notes board' },
                  panelId: 'board',
                  bridge: 'kiki.panel.v1',
                  order: 1,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ code: 40409, msg: 'not found', data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }));

    try {
      const s1 = session('s-one');
      const s2 = session('s-two');
      const items = [threadItem(s1), threadItem(s2)];
      const group = { key: 'today', label: 'Today', items };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      const root = createRoot(container);
      roots.push(root);

      const renderDrawer = async (activeSessionId: string, inert: boolean) => {
        await act(async () => {
          root.render(
            <QueryClientProvider client={client}>
              <I18nProvider>
                <HostProvider host={browserHost}>
                  <MemoryRouter>
                    <Sidebar
                      inert={inert}
                      activeSessionId={activeSessionId}
                      sessions={[s1, s2]}
                      sessionGroups={[group]}
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
                    />
                  </MemoryRouter>
                </HostProvider>
              </I18nProvider>
            </QueryClientProvider>,
          );
        });
      };

      await renderDrawer('s-one', true);
      await settle();
      await renderDrawer('s-two', true);
      await settle();
      expect(slotRequests).toHaveLength(0);
      expect(container.querySelector('[data-plugin-sidebar-panel="notes:board"]')).toBeNull();

      await renderDrawer('s-two', false);
      for (let index = 0; index < 3; index += 1) await settle();
      expect(slotRequests).toHaveLength(1);
      expect(slotRequests[0]).toContain('session_id=s-two');
      expect(container.querySelector('[data-plugin-sidebar-panel="notes:board"]')?.textContent).toContain('Notes board');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('renders smartphone SVG icon for kiki-phone sidebar panel, highlights when open in session, and opens inside session PreviewWorkspace instead of /capabilities', async () => {
    connectionScope.brokerConfig = { url: 'http://127.0.0.1:9999', token: 'tok' };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/plugins/gui-slots')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              slots: [
                {
                  slot: 'sidebar-panel',
                  pluginId: 'kiki-phone',
                  id: 'phone-preview',
                  title: { default: 'Phone Preview', zh: '手机预览' },
                  panelId: 'preview',
                  bridge: 'kiki.panel.v1',
                  order: 1,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ code: 40409, msg: 'not found', data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const openedRequests: Array<{ pluginId: string; panelId: string; title?: string }> = [];
    const registration = registerSessionPluginPanelOpener({
      sessionId: 's-phone',
      open: (req) => {
        openedRequests.push(req);
      },
      activePluginPanelKey: undefined,
    });

    try {
      const sPhone = session('s-phone');
      const group = { key: 'today', label: 'Today', items: [threadItem(sPhone)] };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      const root = createRoot(container);
      roots.push(root);

      function RouteEcho() {
        const loc = useLocation();
        return <div data-sidebar-route={`${loc.pathname}${loc.search}`} />;
      }

      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <I18nProvider>
              <HostProvider host={browserHost}>
                <MemoryRouter initialEntries={['/s/s-phone']}>
                  <RouteEcho />
                  <Sidebar
                    activeSessionId="s-phone"
                    sessions={[sPhone]}
                    sessionGroups={[group]}
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
                  />
                </MemoryRouter>
              </HostProvider>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      for (let index = 0; index < 3; index += 1) await settle();

      const row = container.querySelector<HTMLButtonElement>('[data-plugin-sidebar-panel="kiki-phone:preview"]');
      const moreTools = container.querySelector<HTMLButtonElement>('[data-sidebar-secondary-nav]');
      expect(row).not.toBeNull();
      expect(moreTools).not.toBeNull();
      expect(Boolean(row!.compareDocumentPosition(moreTools!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(row?.querySelector('svg[data-icon="smartphone"]')).not.toBeNull();
      expect(row?.getAttribute('aria-current')).toBeNull();

      await act(async () => {
        row!.click();
      });
      expect(openedRequests).toEqual([
        { pluginId: 'kiki-phone', panelId: 'preview', title: row?.textContent?.trim() },
      ]);
      // Did not navigate away from /s/s-phone!
      expect(container.querySelector('[data-sidebar-route]')?.getAttribute('data-sidebar-route')).toBe('/s/s-phone');

      // When the session opener reports the panel active, Sidebar marks aria-current="page".
      await act(async () => {
        registration.update({
          open: (req) => { openedRequests.push(req); },
          activePluginPanelKey: 'kiki-phone:preview',
        });
      });
      expect(row?.getAttribute('aria-current')).toBe('page');
    } finally {
      registration.unregister();
      resetSessionPluginPanelOpenersForTests();
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('offers private conversation filter options, row lock indicator, and Make private / Exit private row action', async () => {
    const publicSession = session('s-public');
    const privateSession: Session = { ...session('s-private'), title: 'Private diary', private: true };
    const filterChanges: unknown[] = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <HostProvider host={browserHost}>
              <MemoryRouter initialEntries={['/s/s-public']}>
                <Sidebar
                  activeSessionId="s-public"
                  sessions={[publicSession, privateSession]}
                  sessionGroups={[{ key: 'today', label: 'Today', items: [threadItem(publicSession), threadItem(privateSession)] }]}
                  sessionsQuery={{
                    isLoading: false,
                    isError: false,
                    error: null,
                    hasNextPage: false,
                    isFetchingNextPage: false,
                    fetchNextPage: async () => {},
                  }}
                  workspaceOptions={[]}
                  filters={{ ...DEFAULT_SESSION_LIST_FILTERS, private: 'include' }}
                  onFiltersChange={(next) => { filterChanges.push(next); }}
                  onNewSession={() => {}}
                  groupBy="time"
                  onGroupBy={() => {}}
                  sortBy="updated-desc"
                  onSortBy={() => {}}
                  sidebarMode="sessions"
                />
              </MemoryRouter>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    // Private row wears quiet lock glyph, public row does not.
    const privateRow = container.querySelector('[data-session-row="s-private"]');
    const publicRow = container.querySelector('[data-session-row="s-public"]');
    expect(privateRow?.querySelector('[data-session-private] svg[data-icon="lock"]')).not.toBeNull();
    expect(publicRow?.querySelector('[data-session-private]')).toBeNull();

    // Filter chip is shown for non-hide private filter and clears cleanly without dangling `private` key.
    const chips = [...container.querySelectorAll('[data-sidebar-filters] [data-sidebar-filter-chip]')];
    expect(chips.some((chip) => chip.textContent?.includes('Including private'))).toBe(true);

    // Filter menu exposes Hide / Show / Private only options.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-filter-menu-toggle]')!.click();
    });
    const onlyBtn = document.body.querySelector<HTMLButtonElement>('[data-private-filter="only"]');
    const hideBtn = document.body.querySelector<HTMLButtonElement>('[data-private-filter="hide"]');
    expect(onlyBtn).not.toBeNull();
    expect(hideBtn).not.toBeNull();
    await act(async () => { onlyBtn!.click(); });
    expect(filterChanges.at(-1)).toEqual({ status: [], workspaces: [], archived: 'hide', private: 'only' });
    await act(async () => { hideBtn!.click(); });
    expect(filterChanges.at(-1)).toEqual({ status: [], workspaces: [], archived: 'hide' });

    // Close filter menu and open row context menu on public row -> Make private.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-filter-menu-toggle]')!.click();
    });
    await act(async () => {
      publicRow!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 80 }));
    });
    const makePrivateBtn = document.body.querySelector<HTMLButtonElement>('[data-menu-item="private"]');
    expect(makePrivateBtn?.textContent).toBe('Make private');
    await act(async () => { makePrivateBtn!.click(); });
    expect(updateSession).toHaveBeenCalledWith('s-public', { private: true });
  });

  it('guards against concurrent double-toggles while a privacy update is in flight', async () => {
    let resolveToggle!: (value: { id: string; private: boolean }) => void;
    updateSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveToggle = resolve; }),
    );
    const s = session('s-guard');
    const { container } = await mount({
      sessions: [s],
      sessionGroups: [{ key: 'today', label: 'Today', items: [s] }],
    });
    const row = container.querySelector('[data-session-row="s-guard"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 60 }));
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-menu-item="private"]')!.click();
    });
    expect(updateSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 60 }));
    });
    const secondBtn = document.body.querySelector<HTMLButtonElement>('[data-menu-item="private"]')!;
    expect(secondBtn.disabled).toBe(true);
    await act(async () => { secondBtn.click(); });
    expect(updateSession).toHaveBeenCalledTimes(1);

    await act(async () => { resolveToggle({ id: 's-guard', private: true }); });
    await settle();
  });
});

describe('Sidebar inline session rename reliability and confirmation UX', () => {
  const setInputValue = async (input: HTMLInputElement, next: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const openSessionRename = async (container: HTMLElement, id: string) => {
    const row = container.querySelector(`[data-session-row="${id}"]`)!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 32, clientY: 64 }));
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-menu-item="rename"]')!.click();
    });
    return document.body.querySelector<HTMLElement>(`[data-rename-editor="${id}"]`)!;
  };

  it.each([
    { kind: 'session', confirmed: 'Renamed' },
    { kind: 'session', confirmed: 'Another client title' },
    { kind: 'room', confirmed: 'Renamed' },
    { kind: 'room', confirmed: 'Another client title' },
  ] as const)('retires a $kind rename override when the server title reaches $confirmed', async ({ kind, confirmed }) => {
    const id = 'rename-roundtrip';
    const propsFor = (title: string): SidebarOverrides => {
      if (kind === 'room') {
        const room: RoomListItem = {
          kind: 'room', id, title, workspace: 'ws_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          lastSeq: 0, memberCount: 2, busy: false, needsYou: false, pendingInteraction: 'none', failed: false, pinned: false, archived: false,
        };
        return { rooms: [room], sessionGroups: [{ key: 'today', label: 'Today', items: mergeConversationItems([], [room], {}) }] };
      }
      const item = { ...session(id), title };
      return { sessions: [item], sessionGroups: [{ key: 'today', label: 'Today', items: [item] }] };
    };
    roomRest.update.mockResolvedValue({});
    const { container, render } = await mount(propsFor('Original'));
    const row = () => container.querySelector(`[data-${kind}-row="${id}"]`)!;
    await act(async () => { row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 32, clientY: 64 })); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-menu-item="rename"]')!.click(); });
    const editor = document.body.querySelector<HTMLElement>(`[data-rename-editor="${id}"]`)!;
    await setInputValue(editor.querySelector<HTMLInputElement>('[data-rename-input]')!, 'Renamed');
    await act(async () => { editor.querySelector<HTMLButtonElement>('[data-rename-confirm]')!.click(); });
    await settle();
    expect(row().textContent).toContain('Renamed');
    await render(propsFor(confirmed));
    await render(propsFor('Original'));
    expect(row().textContent).toContain('Original');
    expect(row().textContent).not.toContain('Renamed');
  });

  it('ignores an older rename completion after a later rename for the same session', async () => {
    const item = session('rename-race');
    const other = session('other-row');
    let first!: (value: { id: string; title: string }) => void;
    updateSessionProfile.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }));
    const { container, queryClient } = await mount({ sessions: [item, other], sessionGroups: [{ key: 'today', label: 'Today', items: [item, other] }] }, undefined, [item]);
    const submit = async (id: string, name: string) => {
      const editor = await openSessionRename(container, id);
      await setInputValue(editor.querySelector<HTMLInputElement>('[data-rename-input]')!, name);
      await act(async () => { editor.querySelector<HTMLButtonElement>('[data-rename-confirm]')!.click(); });
    };
    await submit(item.id, 'Older response');
    await openSessionRename(container, other.id);
    await submit(item.id, 'Newest name');
    expect(container.querySelector(`[data-session-row="${item.id}"] [data-session-title]`)?.textContent).toContain('Newest name');
    await act(async () => { first({ id: item.id, title: 'Older response' }); });
    expect(container.querySelector(`[data-session-row="${item.id}"] [data-session-title]`)?.textContent).toContain('Newest name');
    expect(queryClient.getQueryData<{ pages: { items: Session[] }[] }>(['sessions', 'cached'])?.pages[0]?.items[0]?.title).toBe('Newest name');
  });

  it('saves via the inline confirm button, prevents duplicate submits, updates cache synchronously, and flashes saved state', async () => {
    let resolveSave!: (value: Session) => void;
    const item = session('s-confirm');
    updateSessionProfile.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSave = resolve as (value: unknown) => void; }),
    );
    const { container, queryClient } = await mount(
      { sessions: [item], sessionGroups: [{ key: 'today', label: 'Today', items: [item] }] },
      undefined,
      [item],
    );
    const editor = await openSessionRename(container, 's-confirm');
    const input = editor.querySelector<HTMLInputElement>('[data-rename-input]')!;
    const confirmBtn = editor.querySelector<HTMLButtonElement>('[data-rename-confirm]')!;
    const cancelBtn = editor.querySelector<HTMLButtonElement>('[data-rename-cancel]')!;
    expect(confirmBtn).not.toBeNull();
    expect(cancelBtn).not.toBeNull();

    await setInputValue(input, 'Renamed via button');
    await act(async () => {
      confirmBtn.click();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(updateSessionProfile).toHaveBeenCalledTimes(1);
    expect(updateSessionProfile).toHaveBeenCalledWith('s-confirm', { title: 'Renamed via button' });
    expect(input.disabled).toBe(true);
    expect(confirmBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);

    await act(async () => { resolveSave({ ...item, title: 'Renamed via button' }); });
    await settle();

    expect(document.body.querySelector('[data-rename-editor="s-confirm"]')).toBeNull();
    expect(container.querySelector('[data-session-row="s-confirm"] [data-session-title]')?.textContent)
      .toContain('Renamed via button');
    expect(container.querySelector('[data-session-row="s-confirm"] [data-rename-saved]')).not.toBeNull();
    const cached = queryClient.getQueryData<{ pages: { items: Session[] }[] }>(['sessions', 'cached']);
    expect(cached?.pages[0]?.items[0]?.title).toBe('Renamed via button');
  });

  it('saves dirty draft on outside pointerdown, and cancels cleanly via Escape or cancel button', async () => {
    const item = session('s-outside');
    const { container } = await mount({
      sessions: [item],
      sessionGroups: [{ key: 'today', label: 'Today', items: [item] }],
    });
    const editor1 = await openSessionRename(container, 's-outside');
    const input1 = editor1.querySelector<HTMLInputElement>('[data-rename-input]')!;
    await setInputValue(input1, 'Draft cancelled');
    await act(async () => {
      editor1.querySelector<HTMLButtonElement>('[data-rename-cancel]')!.click();
    });
    expect(updateSessionProfile).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-rename-editor="s-outside"]')).toBeNull();

    const editor2 = await openSessionRename(container, 's-outside');
    const input2 = editor2.querySelector<HTMLInputElement>('[data-rename-input]')!;
    await setInputValue(input2, 'Saved by outside click');
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await settle();
    expect(updateSessionProfile).toHaveBeenCalledWith('s-outside', { title: 'Saved by outside click' });
    expect(document.body.querySelector('[data-rename-editor="s-outside"]')).toBeNull();
  });

  it('retains the editor and user draft with an inline error when saving fails', async () => {
    updateSessionProfile.mockRejectedValueOnce(new Error('Cold backend failed'));
    const item = session('s-err');
    const { container } = await mount({
      sessions: [item],
      sessionGroups: [{ key: 'today', label: 'Today', items: [item] }],
    });
    const editor = await openSessionRename(container, 's-err');
    const input = editor.querySelector<HTMLInputElement>('[data-rename-input]')!;
    await setInputValue(input, 'Keep my draft');
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-rename-confirm]')!.click();
    });
    await settle();
    expect(document.body.querySelector('[data-rename-editor="s-err"]')).not.toBeNull();
    expect(input.value).toBe('Keep my draft');
    expect(editor.querySelector('[data-rename-error]')?.textContent).toContain('Cold backend failed');
  });

  it('seeds untitled sessions from last_prompt and preserves draft and selection across parent re-renders and focus bounces', async () => {
    const untitledItem: Session = {
      ...session('s-untitled'),
      title: '',
      last_prompt: 'Fix cold session rename',
    };
    const { container, root, queryClient } = await mount({
      sessions: [untitledItem],
      sessionGroups: [{ key: 'today', label: 'Today', items: [untitledItem] }],
    });
    const editor = await openSessionRename(container, 's-untitled');
    const input = editor.querySelector<HTMLInputElement>('[data-rename-input]')!;
    expect(input.value).toBe('Fix cold session rename');

    await setInputValue(input, 'Edited title');
    input.setSelectionRange(6, 6);
    await act(async () => {
      input.dispatchEvent(new FocusEvent('blur'));
      input.focus();
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <HostProvider host={browserHost}>
              <MemoryRouter>
                <MaybeGuard guard={undefined}>
                  <Sidebar
                    activeSessionId={undefined}
                    sessions={[untitledItem]}
                    sessionGroups={[{ key: 'today', label: 'Today', items: [threadItem(untitledItem)] }]}
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
                  />
                </MaybeGuard>
              </MemoryRouter>
            </HostProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    expect(document.body.querySelector('[data-rename-editor="s-untitled"]')).not.toBeNull();
    expect(input.value).toBe('Edited title');
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);

    await setInputValue(input, 'Fix cold session rename');
    await act(async () => {
      editor.querySelector<HTMLButtonElement>('[data-rename-confirm]')!.click();
    });
    await settle();
    expect(updateSessionProfile).toHaveBeenCalledWith('s-untitled', { title: 'Fix cold session rename' });
  });

  it('commits dirty draft and closes unchanged draft on keyboard focus exit outside the rename editor without closing on internal Tab or IME', async () => {
    const item = session('s-tab');
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    try {
      const { container } = await mount({
        sessions: [item],
        sessionGroups: [{ key: 'today', label: 'Today', items: [item] }],
      });
      const editor1 = await openSessionRename(container, 's-tab');
      const input1 = editor1.querySelector<HTMLInputElement>('[data-rename-input]')!;
      const confirm1 = editor1.querySelector<HTMLButtonElement>('[data-rename-confirm]')!;
      const cancel1 = editor1.querySelector<HTMLButtonElement>('[data-rename-cancel]')!;

      // Internal focus movement between input -> confirm -> cancel stays open.
      await act(async () => {
        input1.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: confirm1 }));
        confirm1.focus();
        confirm1.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: cancel1 }));
        cancel1.focus();
      });
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).not.toBeNull();
      expect(updateSessionProfile).not.toHaveBeenCalled();

      // IME composition blur does not dismiss or submit.
      await act(async () => {
        input1.focus();
        input1.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input1.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideButton }));
        input1.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).not.toBeNull();

      // Unchanged draft + Tab focus exit outside closes without saving.
      await act(async () => {
        cancel1.focus();
        cancel1.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideButton }));
        outsideButton.focus();
      });
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).toBeNull();
      expect(updateSessionProfile).not.toHaveBeenCalled();

      // Modified draft + Tab focus exit outside saves once and closes.
      const editor2 = await openSessionRename(container, 's-tab');
      const input2 = editor2.querySelector<HTMLInputElement>('[data-rename-input]')!;
      const cancel2 = editor2.querySelector<HTMLButtonElement>('[data-rename-cancel]')!;
      await setInputValue(input2, 'Saved by Tab exit');
      await act(async () => {
        cancel2.focus();
        cancel2.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideButton }));
        outsideButton.focus();
      });
      await settle();
      expect(updateSessionProfile).toHaveBeenCalledTimes(1);
      expect(updateSessionProfile).toHaveBeenCalledWith('s-tab', { title: 'Saved by Tab exit' });
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).toBeNull();

      // Browser Tab exit out of document (relatedTarget: null) also commits dirty draft, while incidental null blur without Tab stays open.
      const editor3 = await openSessionRename(container, 's-tab');
      const input3 = editor3.querySelector<HTMLInputElement>('[data-rename-input]')!;
      const cancel3 = editor3.querySelector<HTMLButtonElement>('[data-rename-cancel]')!;
      await setInputValue(input3, 'Saved by document Tab exit');
      await act(async () => {
        input3.blur();
        input3.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      });
      await settle();
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).not.toBeNull();
      expect(updateSessionProfile).toHaveBeenCalledTimes(1);

      await act(async () => {
        cancel3.focus();
        cancel3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        cancel3.blur();
        cancel3.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      });
      await settle();
      expect(updateSessionProfile).toHaveBeenCalledTimes(2);
      expect(updateSessionProfile).toHaveBeenLastCalledWith('s-tab', { title: 'Saved by document Tab exit' });
      expect(document.body.querySelector('[data-rename-editor="s-tab"]')).toBeNull();
    } finally {
      outsideButton.remove();
    }
  });

  it('virtualizes 10,000 sessions / 200 workspaces and 2,000 expanded workspace rows while preserving 18px keyline classes', async () => {
    const workspaceCount = 200;
    const workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
      id: `ws_scale_${index}`,
      name: `Workspace ${index}`,
      root: `/w/scale-${index}`,
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-02T00:00:00.000Z',
      session_count: index === 0 ? 2000 : 40,
      pinned: false,
      isGit: true,
    }));
    const sessionsList: Session[] = [];
    for (let i = 0; i < 2000; i += 1) {
      sessionsList.push({
        ...session(`s_big_${i}`),
        workspace_id: 'ws_scale_0',
        title: `Big workspace thread ${i}`,
        updated_at: new Date(Date.UTC(2026, 0, 2) - i * 1000).toISOString(),
      });
    }
    for (let ws = 1; ws < workspaceCount; ws += 1) {
      for (let j = 0; j < 40; j += 1) {
        sessionsList.push({
          ...session(`s_ws${ws}_${j}`),
          workspace_id: `ws_scale_${ws}`,
          title: `Thread ws${ws}-${j}`,
          updated_at: new Date(Date.UTC(2026, 0, 1) - (ws * 40 + j) * 1000).toISOString(),
        });
      }
    }
    // 2,000 + 199 * 40 = 9,960 sessions (plus 40 extra = 10,000)
    for (let k = 0; k < 40; k += 1) {
      sessionsList.push({
        ...session(`s_tail_${k}`),
        workspace_id: 'ws_scale_199',
        title: `Tail thread ${k}`,
        updated_at: new Date(Date.UTC(2025, 11, 1) - k * 1000).toISOString(),
      });
    }
    expect(sessionsList).toHaveLength(10_000);

    const byWorkspace = new Map<string, Session[]>();
    for (const item of sessionsList) {
      const bucket = byWorkspace.get(item.workspace_id);
      if (bucket === undefined) byWorkspace.set(item.workspace_id, [item]);
      else bucket.push(item);
    }
    const groups = workspaces.map((ws) => ({
      key: ws.id,
      label: ws.name,
      items: byWorkspace.get(ws.id) ?? [],
    }));

    const { container } = await mount({
      sessions: sessionsList,
      sessionGroups: groups,
      workspaceOptions: workspaces,
      groupBy: 'workspace',
    });

    const listEl = container.querySelector('[data-session-list]')!;
    expect(listEl.className).toContain('px-2.5');
    expect(container.querySelector('[data-session-list-virtualized="true"]')).not.toBeNull();
    const initialRows = container.querySelectorAll('[data-session-row]');
    expect(initialRows.length).toBeGreaterThan(5);
    expect(initialRows.length).toBeLessThanOrEqual(60);
    // Preserve 18px keyline: outer px-2.5 (10px) + row button pl-2 (8px)
    expect(initialRows[0]?.querySelector('button')?.className).toContain('pl-2');

    // Expand workspace 0 (2,000 sessions): DOM stays strictly bounded.
    const showMore = container.querySelector<HTMLButtonElement>('[data-session-group-more="ws_scale_0"]')!;
    expect(showMore).not.toBeNull();
    await act(async () => { showMore.click(); });
    const expandedRows = container.querySelectorAll('[data-session-row]');
    expect(expandedRows.length).toBeGreaterThan(5);
    expect(expandedRows.length).toBeLessThanOrEqual(60);
  });

  it('virtualizes SearchResults when searching across 10,000 sessions and large server hit pages', async () => {
    const sessionsList = Array.from({ length: 10_000 }, (_, i) => ({
      ...session(`s_find_${i}`),
      workspace_id: 'ws-a',
      title: `Scale session ${i}`,
      updated_at: new Date(Date.UTC(2026, 0, 2) - i * 1000).toISOString(),
    }));
    const manyHits = Array.from({ length: 200 }, (_, i) => hit({
      session_id: `s_find_${i}`,
      session_title: `Scale session ${i}`,
      snippet: `Scale session match snippet ${i}`,
      turn: i,
    }));
    searchMessages.mockResolvedValue(page(manyHits, false, undefined, {
      index_state: { state: 'ready', indexed_sessions: 10_000, total_sessions: 10_000, documents: 10_000 },
    }));

    const { container } = await mount({
      sessions: sessionsList,
      sessionGroups: [{ key: 'all', label: 'All', items: sessionsList }],
      groupBy: 'none',
    });
    expect(container.querySelector('[data-session-list-virtualized="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-session-row]').length).toBeLessThanOrEqual(60);

    // Open search and type a query matching local + 200 server hits.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-search-toggle]')!.click();
    });
    const searchInput = container.querySelector<HTMLInputElement>('[data-search-box]')!;
    await setInputValue(searchInput, 'Scale session');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, CONTENT_SEARCH_DEBOUNCE_MS + 40)); });
    await settle();

    expect(container.querySelector('[data-search-results-virtualized="true"]')).not.toBeNull();
    const renderedResults = container.querySelectorAll('[data-search-result]');
    expect(renderedResults.length).toBeGreaterThan(5);
    expect(renderedResults.length).toBeLessThanOrEqual(60);
  });
});

describe('Sidebar Vibe42 Inbox-Zero, zero-jank pin, triage, 72h cold fold & optimistic click-to-read', () => {
  it('defaults to sessions when inbox has 0 actionable items while keeping the single unread badge on the inbox tab, and defaults to inbox when an item needs you', async () => {
    const done = { ...session('s-done'), last_turn_reason: 'completed' as const, last_seq: 5, updated_at: '2026-10-06T10:00:00Z' };
    const { container } = await mount({
      sidebarMode: undefined,
      sessions: [done],
      sessionGroups: [{ key: 'today', label: 'Today', items: [done] }],
      nowMs: FIXTURE_NOW_MS,
    });
    expect(container.querySelector('[data-sidebar-mode="sessions"]')?.getAttribute('aria-selected')).toBe('true');
    // Exactly one badge exists (on the Inbox tab), never duplicated on the bell button.
    expect(container.querySelectorAll('[data-activity-badge]')).toHaveLength(1);
    expect(container.querySelector('[data-nav-activity] [data-activity-badge]')).toBeNull();
    expect(container.querySelector('[data-sidebar-mode="inbox"] [data-activity-badge]')?.getAttribute('data-activity-badge-tone')).toBe('unread');

    const blocked = { ...session('s-blocked'), pending_interaction: 'approval' as const, last_seq: 6, updated_at: '2026-10-06T10:05:00Z' };
    const mountedBlocked = await mount({
      sidebarMode: undefined,
      sessions: [blocked],
      sessionGroups: [{ key: 'today', label: 'Today', items: [blocked] }],
      nowMs: FIXTURE_NOW_MS,
    });
    expect(mountedBlocked.container.querySelector('[data-sidebar-mode="inbox"]')?.getAttribute('aria-selected')).toBe('true');
    expect(mountedBlocked.container.querySelector('[data-sidebar-inbox]')).not.toBeNull();
  });

  it('keeps sessions active after dragging sidebar width when needsYouCount is 0 without persisting implicit inbox mode', async () => {
    const done = { ...session('s-done'), last_turn_reason: 'completed' as const, last_seq: 5, updated_at: '2026-10-06T10:00:00Z' };
    const { container } = await mount({
      sidebarMode: undefined,
      sessions: [done],
      sessionGroups: [{ key: 'today', label: 'Today', items: [done] }],
      nowMs: FIXTURE_NOW_MS,
    });
    expect(container.querySelector('[data-sidebar-mode="sessions"]')?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      writeLayoutPreferences({ sidebarWidth: 324 });
    });

    expect(container.querySelector('[data-sidebar-mode="sessions"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-sidebar-mode="inbox"]')?.getAttribute('aria-selected')).toBe('false');
    const stored = JSON.parse(localStorage.getItem('kiki.layout') ?? '{}') as Record<string, unknown>;
    expect(stored['sidebarWidth']).toBe(324);
    expect(stored['sidebarMode']).toBeUndefined();
  });

  it('holds a clicked unread done row in place (zero-jank viewing pin) with cleared dot until settled, busy, or navigated away', async () => {
    const s1 = { ...session('s-1'), title: 'First done', last_turn_reason: 'completed' as const, last_seq: 8, updated_at: '2026-10-06T11:00:00Z' };
    const s2 = { ...session('s-2'), title: 'Second done', last_turn_reason: 'completed' as const, last_seq: 6, updated_at: '2026-10-06T10:00:00Z' };
    const mounted = await mount({
      sidebarMode: 'inbox',
      sessions: [s1, s2],
      sessionGroups: [{ key: 'today', label: 'Today', items: [s1, s2] }],
      nowMs: FIXTURE_NOW_MS,
    });
    const row1 = mounted.container.querySelector('[data-inbox-row="s-1"]')!;
    expect(row1.getAttribute('data-inbox-unread')).toBe('true');

    // Click s-1: unread dot clears synchronously AND row stays pinned in active stream.
    await act(async () => {
      row1.querySelector<HTMLButtonElement>('button')!.click();
    });
    const pinnedRow = mounted.container.querySelector('[data-inbox-row="s-1"]');
    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow?.getAttribute('data-inbox-unread')).toBe('false');

    // Settle via ✓ button (or e): row disappears from active stream immediately.
    await act(async () => {
      pinnedRow?.querySelector<HTMLButtonElement>('[data-inbox-action="settle"]')!.click();
    });
    expect(mounted.container.querySelector('[data-inbox-row="s-1"]')).toBeNull();
    expect(mounted.container.querySelector('[data-inbox-row="s-2"]')).not.toBeNull();

    // Press u (undo): s-1 returns cleanly to active stream!
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' }));
    });
    expect(mounted.container.querySelector('[data-inbox-row="s-1"]')).not.toBeNull();
  });

  it('supports snooze (with wake-now), reversible inbox archive (with restore), omits settle on needsYou, and shows All clear when empty', async () => {
    const blocked = { ...session('s-wait'), title: 'Needs approval', pending_interaction: 'approval' as const, last_seq: 4, updated_at: '2026-10-06T11:00:00Z' };
    const done = { ...session('s-done'), title: 'Finished build', last_turn_reason: 'completed' as const, last_seq: 9, updated_at: '2026-10-06T10:30:00Z' };
    const running = { ...session('s-run'), title: 'Running tests', busy: true, executing: true, last_seq: 3, updated_at: '2026-10-06T11:30:00Z' };
    const { container } = await mount({
      sidebarMode: 'inbox',
      sessions: [blocked, done, running],
      sessionGroups: [{ key: 'today', label: 'Today', items: [blocked, done, running] }],
      nowMs: FIXTURE_NOW_MS,
    });

    // Unresolved needsYou must NOT offer settle ✓.
    const waitRow = container.querySelector('[data-inbox-row="s-wait"]')!;
    expect(waitRow.querySelector('[data-inbox-action="settle"]')).toBeNull();

    // Snooze blocked row for 1h -> moves to Snoozed drawer.
    await act(async () => {
      waitRow.querySelector<HTMLButtonElement>('[data-inbox-action="snooze"]')!.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-snooze-preset="1h"]')!.click();
    });
    expect(container.querySelector('[data-inbox-active-list] [data-inbox-row="s-wait"]')).toBeNull();
    expect(container.querySelector('[data-inbox-drawer="snoozed"]')).not.toBeNull();

    // Archive done row -> active stream becomes empty -> All clear + Working/Snoozed/Archived bottom drawers.
    const doneRow = container.querySelector('[data-inbox-row="s-done"]')!;
    await act(async () => {
      doneRow.querySelector<HTMLButtonElement>('[data-inbox-action="archive"]')!.click();
    });
    expect(container.querySelector('[data-inbox-all-clear]')?.textContent).toContain('All clear');
    expect(container.querySelector('[data-inbox-drawer="working"] [data-inbox-row="s-run"]')).not.toBeNull();
    expect(container.querySelector('[data-inbox-drawer="archived"]')).not.toBeNull();

    // Expand Snoozed and wake s-wait immediately.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-inbox-drawer-toggle="snoozed"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-inbox-drawer="snoozed"] [data-inbox-action="wake"]')!.click();
    });
    expect(container.querySelector('[data-inbox-active-list] [data-inbox-row="s-wait"]')).not.toBeNull();
  });

  it('folds post-week historical read sessions in time-grouped Sessions view while keeping week/recent and protected rows visible, and clears unread immediately on cold-session click', async () => {
    const recent = { ...session('s-recent'), title: 'Recent work', updated_at: '2026-10-06T09:00:00Z', last_seq: 0 };
    const weekRead = { ...session('s-week-read'), title: 'This week read', updated_at: '2026-10-01T09:00:00Z', last_seq: 0 };
    const oldRead = { ...session('s-old-read'), title: 'Old read thread', updated_at: '2026-09-20T09:00:00Z', last_seq: 0 };
    const oldUnread = { ...session('s-old-unread'), title: 'Old unread thread', updated_at: '2026-09-18T09:00:00Z', last_seq: 7, last_turn_reason: 'completed' as const };
    // Clicking the cold unread session clears its unread state synchronously!
    const { container, render } = await mount({
      sidebarMode: 'sessions',
      sessions: [recent, weekRead, oldRead, oldUnread],
      sessionGroups: [
        { key: 'today', label: 'Today', items: [recent] },
        { key: 'week', label: 'Previous 7 days', items: [weekRead] },
        { key: 'month', label: 'Past 30 days', items: [oldRead, oldUnread] },
      ],
      groupBy: 'time',
      nowMs: FIXTURE_NOW_MS,
    });

    // Today & week stay visible; month read session folds behind Older · 1; month unread stays visible.
    expect(container.querySelector('[data-session-row="s-recent"]')).not.toBeNull();
    expect(container.querySelector('[data-session-row="s-week-read"]')).not.toBeNull();
    expect(container.querySelector('[data-session-row="s-old-read"]')).toBeNull();
    expect(container.querySelector('[data-session-row="s-old-unread"]')?.getAttribute('data-session-row-state')).toBe('unread');
    const foldToggle = container.querySelector<HTMLButtonElement>('[data-sidebar-cold-fold="collapsed"]')!;
    expect(foldToggle.textContent).toContain('Older · 1');

    // Clicking the cold unread session clears its unread state synchronously!
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-session-row="s-old-unread"] button')!.click();
    });
    // Navigation activates s-old-unread, protecting it from being folded while open.
    await render({
      sidebarMode: 'sessions',
      activeSessionId: 's-old-unread',
      sessions: [recent, weekRead, oldRead, oldUnread],
      sessionGroups: [
        { key: 'today', label: 'Today', items: [recent] },
        { key: 'week', label: 'Previous 7 days', items: [weekRead] },
        { key: 'month', label: 'Past 30 days', items: [oldRead, oldUnread] },
      ],
      groupBy: 'time',
      nowMs: FIXTURE_NOW_MS,
    });
    expect(container.querySelector('[data-session-row="s-old-unread"]')?.getAttribute('data-session-row-state')).toBe('read');

    // Expanding the fold reveals the folded historical read row.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sidebar-cold-fold="collapsed"]')!.click();
    });
    expect(container.querySelector('[data-session-row="s-old-read"]')).not.toBeNull();
  });

  it('opens a remote unread row in-place via /p/:connectionId/s/:id without scope handoff, keeps it pinned while viewing, and releases pin on navigation away', async () => {
    const localA = { ...session('s-a'), title: 'Local A', last_seq: 0, updated_at: '2026-10-06T11:00:00Z' };
    const remoteB = { ...session('s-remote-b'), title: 'Remote B done', last_turn_reason: 'completed' as const, last_seq: 11, updated_at: '2026-10-06T11:30:00Z' };
    const localC = { ...session('s-c'), title: 'Local C', last_seq: 0, updated_at: '2026-10-06T10:00:00Z' };
    const remoteConnId = '11111111-1111-4111-8111-111111111111';
    const remoteKey = `remote:${remoteConnId}`;
    const sources = [
      { spaceKey: 'main', spaceName: 'Main space', isRemote: false, sessions: [localA, localC], rooms: [], workspaces: [] },
      { spaceKey: remoteKey, spaceName: 'GPU Box', isRemote: true, sessions: [remoteB], rooms: [], workspaces: [] },
    ];
    const scopeNav = vi.fn(async () => undefined);
    const unregister = registerScopeNavigation(scopeNav);
    try {
      const mounted = await mount({
        sidebarMode: 'inbox',
        activeSessionId: 's-a',
        sessions: [localA, localC],
        sessionGroups: [{ key: 'today', label: 'Today', items: [localA, localC] }],
        multiSpaceSources: sources,
        nowMs: FIXTURE_NOW_MS,
      });

      // Click remote B while viewing local A -> navigates in-place to /p/<id>/s/s-remote-b
      // without invoking cross-space scopeNav handoff.
      await act(async () => {
        mounted.container.querySelector<HTMLButtonElement>('[data-inbox-row="s-remote-b"] button')!.click();
      });
      await settle();

      expect(scopeNav).not.toHaveBeenCalled();
      const pinnedRow = mounted.container.querySelector('[data-inbox-row="s-remote-b"]');
      expect(pinnedRow).not.toBeNull();
      expect(pinnedRow?.getAttribute('data-inbox-unread')).toBe('false');

      // Clicking another local conversation (local C) navigates away and releases the viewing pin cleanly.
      const localCUnread = { ...localC, last_turn_reason: 'completed' as const, last_seq: 5 };
      const nextSources = [
        { spaceKey: 'main', spaceName: 'Main space', isRemote: false, sessions: [localA, localCUnread], rooms: [], workspaces: [] },
        { spaceKey: remoteKey, spaceName: 'GPU Box', isRemote: true, sessions: [remoteB], rooms: [], workspaces: [] },
      ];
      await mounted.render({
        sidebarMode: 'inbox',
        activeSessionId: 's-remote-b',
        sessions: [localA, localCUnread],
        sessionGroups: [{ key: 'today', label: 'Today', items: [localA, localCUnread] }],
        multiSpaceSources: nextSources,
        nowMs: FIXTURE_NOW_MS,
      });
      await act(async () => {
        mounted.container.querySelector<HTMLButtonElement>('[data-inbox-row="s-c"] button')!.click();
      });
      await settle();
      expect(mounted.container.querySelector('[data-inbox-row="s-remote-b"]')).toBeNull();
    } finally {
      unregister();
    }
  });

  it('routes another local subspace via scopeNav and rolls back optimistic read + pin on abort', async () => {
    const otherLocalSpaceKey = 'h-nia';
    const localA = { ...session('s-local-a'), title: 'Local A', last_seq: 0, updated_at: '2026-10-06T11:00:00Z' };
    const subspaceUnread = { ...session('s-subspace-unread'), title: 'Subspace unread', last_turn_reason: 'completed' as const, last_seq: 9, updated_at: '2026-10-06T11:20:00Z' };
    const sources = [
      { spaceKey: 'main', spaceName: 'Main space', isRemote: false, sessions: [localA], rooms: [], workspaces: [] },
      { spaceKey: otherLocalSpaceKey, spaceName: 'Nia Space', isRemote: false, sessions: [subspaceUnread], rooms: [], workspaces: [] },
    ];
    let rejectNav!: (err: unknown) => void;
    const scopeNav = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectNav = reject; }));
    const unregister = registerScopeNavigation(scopeNav);
    try {
      const mounted = await mount({
        sidebarMode: 'inbox',
        activeSessionId: 's-local-a',
        sessions: [localA],
        sessionGroups: [{ key: 'today', label: 'Today', items: [localA] }],
        multiSpaceSources: sources,
        nowMs: FIXTURE_NOW_MS,
      });
      await act(async () => {
        mounted.container.querySelector<HTMLButtonElement>('[data-inbox-row="s-subspace-unread"] button')!.click();
      });
      expect(scopeNav).toHaveBeenCalledWith({
        homeId: otherLocalSpaceKey,
        scopeId: 'local',
        route: '/s/s-subspace-unread',
        inPlace: true,
      });
      // Optimistically cleared while in flight.
      expect(mounted.container.querySelector('[data-inbox-row="s-subspace-unread"]')?.getAttribute('data-inbox-unread')).toBe('false');

      // DirtyGuard / abort rejects navigation -> optimistic read overlay rolls back so unread dot returns.
      await act(async () => {
        rejectNav(new DOMException('Navigation cancelled.', 'AbortError'));
      });
      await settle();
      expect(mounted.container.querySelector('[data-inbox-row="s-subspace-unread"]')?.getAttribute('data-inbox-unread')).toBe('true');
    } finally {
      unregister();
    }
  });

  it('renders unified typographic tabs with keyboard roving focus and right-aligned session tools without a duplicate Sessions heading', async () => {
    const running = { ...session('s-run'), title: 'Running job', busy: true, executing: true, last_seq: 4, updated_at: '2026-10-06T11:30:00Z' };
    const { container, render } = await mount({
      sidebarMode: 'sessions',
      sessions: [running],
      sessionGroups: [{ key: 'today', label: 'Today', items: [running] }],
      nowMs: FIXTURE_NOW_MS,
    });
    const inboxTab = container.querySelector<HTMLButtonElement>('[data-sidebar-mode="inbox"]')!;
    const sessionsTab = container.querySelector<HTMLButtonElement>('[data-sidebar-mode="sessions"]')!;
    expect(sessionsTab.getAttribute('aria-selected')).toBe('true');
    expect(sessionsTab.tabIndex).toBe(0);
    expect(inboxTab.tabIndex).toBe(-1);

    // Inline session actions live on the right of the unified mode bar, not below a duplicate Sessions heading.
    const actionsBar = container.querySelector('[data-sidebar-mode-actions]');
    expect(actionsBar).not.toBeNull();
    expect(actionsBar?.querySelector('[data-filter-menu-toggle]')).not.toBeNull();
    expect(actionsBar?.querySelector('[data-view-menu-toggle]')).not.toBeNull();
    expect(actionsBar?.querySelector('[data-status-shortcut="running"]')).not.toBeNull();
    expect(container.querySelector('[data-session-list] h2')).toBeNull();

    // ArrowLeft switches cleanly to inbox mode and hides session-list tools.
    await act(async () => {
      sessionsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await render({
      sidebarMode: 'inbox',
      sessions: [running],
      sessionGroups: [{ key: 'today', label: 'Today', items: [running] }],
      nowMs: FIXTURE_NOW_MS,
    });
    expect(container.querySelector('[data-sidebar-mode="inbox"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-sidebar-mode-actions]')).toBeNull();
  });

  it('keeps the currently entered running or idle conversation visible in inbox active list without inflating badges, and moves it to working when navigating away', async () => {
    const running = { ...session('s-run'), title: 'Active running thread', busy: true, executing: true, last_seq: 3, updated_at: '2026-10-06T11:30:00Z' };
    const idle = { ...session('s-idle'), title: 'Quiet settled thread', last_seq: 0, updated_at: '2026-10-06T10:00:00Z' };
    const mounted = await mount({
      sidebarMode: 'inbox',
      activeSessionId: 's-run',
      sessions: [running, idle],
      sessionGroups: [{ key: 'today', label: 'Today', items: [running, idle] }],
      nowMs: FIXTURE_NOW_MS,
    });

    // While inside s-run as it executes, it stays in the primary active list (not hidden in Working drawer) with zero badge.
    expect(mounted.container.querySelector('[data-inbox-active-list] [data-inbox-row="s-run"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-inbox-drawer="working"] [data-inbox-row="s-run"]')).toBeNull();
    expect(mounted.container.querySelector('[data-activity-badge]')).toBeNull();

    // Navigating to s-idle moves s-run cleanly into the Working drawer and keeps s-idle visible in the primary active list.
    await mounted.render({
      sidebarMode: 'inbox',
      activeSessionId: 's-idle',
      sessions: [running, idle],
      sessionGroups: [{ key: 'today', label: 'Today', items: [running, idle] }],
      nowMs: FIXTURE_NOW_MS,
    });
    expect(mounted.container.querySelector('[data-inbox-active-list] [data-inbox-row="s-idle"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-inbox-active-list] [data-inbox-row="s-run"]')).toBeNull();
    expect(mounted.container.querySelector('[data-inbox-drawer="working"] [data-inbox-row="s-run"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-activity-badge]')).toBeNull();
  });

  it('targets the clicked local subspace homeId (not main) when opening a cross-subspace inbox item', async () => {
    const subSession = { ...session('s-sub'), title: 'Subspace run', last_turn_reason: 'completed' as const, last_seq: 5, updated_at: '2026-10-06T11:20:00Z' };
    const sources = [
      { spaceKey: 'main', spaceName: 'Main space', isRemote: false, sessions: [], rooms: [], workspaces: [] },
      { spaceKey: 'sub-work', spaceName: 'Work', isRemote: false, sessions: [subSession], rooms: [], workspaces: [] },
    ];
    const scopeNav = vi.fn(async () => {});
    const unregister = registerScopeNavigation(scopeNav);
    try {
      const mounted = await mount({
        sidebarMode: 'inbox',
        sessions: [],
        sessionGroups: [],
        multiSpaceSources: sources,
        nowMs: FIXTURE_NOW_MS,
      });
      await act(async () => {
        mounted.container.querySelector<HTMLButtonElement>('[data-inbox-row="s-sub"] button')!.click();
      });
      expect(scopeNav).toHaveBeenCalledWith({
        homeId: 'sub-work',
        scopeId: 'local',
        route: '/s/s-sub',
        inPlace: true,
      });
    } finally {
      unregister();
    }
  });
});

describe('Sidebar automatic session groups & single-demand infinite scroll', () => {
  beforeEach(() => {
    stubViewportWidth(1440);
  });

  function unitBucket(
    key: string,
    label: string,
    items: readonly import('@kiki/session-core/sessions').SidebarDisplayItem[],
  ): import('@kiki/session-core/sessions').SidebarDisplayBucket {
    return { key, label, items, total: items.length };
  }

  function unitGroupItem(
    groupId: string,
    title: string,
    members: readonly Session[],
    extra: Partial<Extract<import('@kiki/session-core/sessions').SidebarDisplayItem, { kind: 'session-group' }>> = {},
  ): Extract<import('@kiki/session-core/sessions').SidebarDisplayItem, { kind: 'session-group' }> {
    return {
      kind: 'session-group',
      key: `group:${groupId}`,
      groupId,
      openerId: members[0]!.id,
      title,
      workspaceId: members[0]!.workspace_id,
      createdAt: members[0]!.created_at,
      updatedAt: members[0]!.updated_at,
      sortAt: Date.parse(members[0]!.updated_at) || 0,
      pinned: members.some((m) => isPinnedSession(m)),
      memberCount: extra.memberCount ?? members.length,
      members: members.map((m) => ({
        ...(threadItem(m) as Extract<ConversationListItem, { kind: 'session' }>),
        groupId,
      })),
      membersNextCursor: extra.membersNextCursor,
      spaceKey: extra.spaceKey ?? 'main',
      partialCoverage: extra.partialCoverage ?? false,
      ...extra,
    };
  }

  it('flattens automatic session groups transparently into top-level rows and exposes load-more tail when >50 members exist', async () => {
    const opener = { ...session('s_open'), title: 'Release checklist', updated_at: '2026-10-06T11:00:00Z' };
    const child = {
      ...session('s_old_child'),
      title: '90-day-old child',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      metadata: { cwd: 'C:/tmp', created_by_session_id: 's_open' } as Session['metadata'],
    };
    const onLoadMoreGroupMembers = vi.fn(async () => {});
    const grp = unitGroupItem('grp_big', 'Release checklist', [opener, child], {
      memberCount: 54,
      membersNextCursor: 'cur_m_50',
    });

    const first = await mount({
      sessions: [opener, child],
      sessionGroups: [],
      sidebarGroupsEnabled: true,
      sidebarUnitBuckets: [unitBucket('today', 'Today', [grp])],
      onLoadMoreGroupMembers,
      nowMs: FIXTURE_NOW_MS,
    });

    // No collapsed group header — both opener and member render directly as top-level rows.
    expect(first.container.querySelector('[data-sidebar-unit-group="grp_big"]')).toBeNull();
    expect(first.container.querySelector('[data-session-row="s_open"]')).not.toBeNull();
    expect(first.container.querySelector('[data-session-row="s_old_child"]')).not.toBeNull();
    expect(first.container.querySelector('[data-session-row="s_old_child"] [data-session-relation-note]')).toBeNull();

    // >50-member tail remains reachable via SessionGroupMoreRow and forwards cursor cleanly.
    const moreBtn = first.container.querySelector<HTMLButtonElement>('[data-sidebar-unit-group-more="grp_big"]')!;
    expect(moreBtn).not.toBeNull();
    await act(async () => { moreBtn.click(); });
    expect(onLoadMoreGroupMembers).toHaveBeenCalledWith('grp_big', 'main', 'cur_m_50');
  });

  it('routes detach-group through server callback instead of local topLevelThreads and archives single members with include_attached=false', async () => {
    const opener = { ...session('s_root'), title: 'Group opener', updated_at: '2026-10-06T11:00:00Z' };
    const member = {
      ...session('s_member'),
      title: 'Detached candidate',
      updated_at: '2026-10-06T11:05:00Z',
      metadata: { cwd: 'C:/tmp', created_by_session_id: 's_root' } as Session['metadata'],
    };
    const grp = unitGroupItem('grp_detach', 'Group opener', [opener, member]);
    const onDetachGroupMember = vi.fn(async (_sessionId: string) => ({ previousGroupId: 'grp_detach' }));
    writeWorkspaceGroupMemory('local', {
      collapsed: [],
      expanded: [],
      expandedSessionGroups: ['grp_detach'],
    });
    archiveSession.mockResolvedValueOnce(archived('s_member'));

    const { container } = await mount({
      sessions: [opener, member],
      sessionGroups: [],
      sidebarGroupsEnabled: true,
      sidebarUnitBuckets: [unitBucket('today', 'Today', [grp])],
      onDetachGroupMember,
      nowMs: FIXTURE_NOW_MS,
    });

    await act(async () => {
      container.querySelector('[data-session-row="s_member"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(container.querySelector('[data-menu-item="thread-display"]')).toBeNull();
    const detachBtn = container.querySelector<HTMLButtonElement>('[data-menu-item="detach-group"]')!;
    expect(detachBtn).not.toBeNull();
    await act(async () => { detachBtn.click(); });
    expect(onDetachGroupMember).toHaveBeenCalledWith('s_member');

    // Single-member archive passes include_attached: false.
    await act(async () => {
      container.querySelector('[data-session-row="s_member"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const archiveBtn = container.querySelector<HTMLButtonElement>('[data-menu-item="archive"]')!;
    await act(async () => { archiveBtn.click(); });
    expect(archiveSession).toHaveBeenCalledWith('s_member', { include_attached: false });
  });

  it('never auto-fetches next pages in zero-geometry jsdom, exposes manual load-more and retry, and keeps 2,000 sessions virtualized', async () => {
    const fetchNextPage = vi.fn(async () => {});
    const manySessions = Array.from({ length: 2000 }, (_, i) => ({
      ...session(`s_${i}`),
      title: `Session ${i}`,
      updated_at: new Date(FIXTURE_NOW_MS - i * 60_000).toISOString(),
    }));
    const { container } = await mount({
      sessions: manySessions,
      sessionGroups: [{ key: 'today', label: 'Today', items: manySessions }],
      sessionsQuery: {
        isLoading: false,
        isError: false,
        error: null,
        hasNextPage: true,
        isFetchingNextPage: false,
        fetchNextPage,
      },
      nowMs: FIXTURE_NOW_MS,
    });

    // Zero-height jsdom never fires automatic infinite demand.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(fetchNextPage).not.toHaveBeenCalled();

    // Virtualization keeps mounted DOM rows tiny even with 2,000 sessions.
    const mountedRows = container.querySelectorAll('[data-session-row]').length;
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(80);

    // Manual Load more button still triggers demand when scrolled to end or clicked.
    const list = container.querySelector<HTMLElement>('[data-session-list]')!;
    expect(list.querySelector('[data-session-list-virtualized="true"]')).not.toBeNull();
  });

  it('toggles per-session notification mute from the context menu, preserves authoritative custom metadata, renders muted-bell badge, and suppresses routine unread dot', async () => {
    const patrol = {
      ...session('s_patrol'),
      title: 'Patrol Cron',
      last_seq: 15,
      last_turn_reason: 'completed' as const,
      updated_at: '2026-10-06T11:30:00Z',
      metadata: { cwd: 'C:/tmp' } as Session['metadata'],
    };
    const mutedPatrol = {
      ...session('s_patrol_muted'),
      title: 'Muted Patrol',
      last_seq: 15,
      last_turn_reason: 'completed' as const,
      updated_at: '2026-10-06T11:25:00Z',
      metadata: { cwd: 'C:/tmp', 'kiki.notifications': 'off' } as Session['metadata'],
    };
    // Authoritative server records carry extra custom metadata keys absent from bounded SidebarRow projections.
    const authoritativePatrol = {
      ...patrol,
      metadata: {
        cwd: 'C:/tmp',
        local_session: true,
        plugin_import_job: 'job-42',
        persona_home_managed: true,
        custom_plugin_flag: 'keep-me',
      } as Session['metadata'],
    };
    const authoritativeMuted = {
      ...mutedPatrol,
      metadata: {
        cwd: 'C:/tmp',
        'kiki.notifications': 'off',
        local_session: true,
        custom_plugin_flag: 'keep-me-too',
      } as Session['metadata'],
    };
    getSession.mockImplementation(async (id: string) => {
      if (id === 's_patrol') return authoritativePatrol;
      if (id === 's_patrol_muted') return authoritativeMuted;
      throw new Error('Thread not found');
    });

    const { container } = await mount({
      sessions: [patrol, mutedPatrol],
      sessionGroups: [{ key: 'today', label: 'Today', items: [patrol, mutedPatrol] }],
      nowMs: FIXTURE_NOW_MS,
    });

    const activeRow = container.querySelector('[data-session-row="s_patrol"]')!;
    const mutedRow = container.querySelector('[data-session-row="s_patrol_muted"]')!;
    expect(activeRow.getAttribute('data-session-row-state')).toBe('unread');
    expect(activeRow.querySelector('[data-session-muted]')).toBeNull();
    expect(mutedRow.getAttribute('data-session-row-state')).toBe('read');
    expect(mutedRow.querySelector('[data-session-muted]')).not.toBeNull();

    await act(async () => {
      activeRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const muteItem = container.querySelector<HTMLButtonElement>('[data-menu-action="toggle-mute"]')!;
    expect(muteItem).not.toBeNull();
    expect(muteItem.textContent).toBe('Mute notifications');
    await act(async () => { muteItem.click(); });
    expect(getSession).toHaveBeenCalledWith('s_patrol');
    expect(updateSessionProfile).toHaveBeenCalledWith('s_patrol', {
      metadata: {
        cwd: 'C:/tmp',
        local_session: true,
        plugin_import_job: 'job-42',
        persona_home_managed: true,
        custom_plugin_flag: 'keep-me',
        'kiki.notifications': 'off',
      },
    });

    await act(async () => {
      mutedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const unmuteItem = container.querySelector<HTMLButtonElement>('[data-menu-action="toggle-mute"]')!;
    expect(unmuteItem).not.toBeNull();
    expect(unmuteItem.textContent).toBe('Unmute notifications');
    await act(async () => { unmuteItem.click(); });
    expect(getSession).toHaveBeenCalledWith('s_patrol_muted');
    expect(updateSessionProfile).toHaveBeenLastCalledWith('s_patrol_muted', {
      metadata: {
        cwd: 'C:/tmp',
        local_session: true,
        custom_plugin_flag: 'keep-me-too',
      },
    });
  });
});
