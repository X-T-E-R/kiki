// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSessionHeadsQuery, Session } from '@kiki/protocol';
import { resetLayoutPreferencesForTests, writeLayoutPreferences } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { buildPersonaDirectory, type PersonaDirectoryEntry } from './usePersonaDirectory';
import {
  SIDEBAR_PERSONA_INLINE_THREAD_LIMIT,
  SIDEBAR_PERSONA_ORDER_KEY,
  SIDEBAR_PERSONA_PREVIEW_LIMIT,
  SidebarPersonaSection,
  orderSidebarPersonas,
  reorderPersonaIds,
} from './SidebarPersonaSection';
import { personaSwitcherQueryKey, type PersonaSessionHeadsMap } from './usePersonaSwitcherConversations';

const navigate = vi.fn();
const directory = vi.hoisted(() => ({ entries: [] as unknown[] }));
const listSessions = vi.hoisted(() => vi.fn(async (_params?: { persona?: string }) => ({ items: [] as unknown[], has_more: false })));
const listPersonaSessionHeads = vi.hoisted(() =>
  vi.fn(async (_params?: PersonaSessionHeadsQuery): Promise<PersonaSessionHeadsMap> => ({})),
);
const updatePersona = vi.hoisted(() => vi.fn(async (_id: string, patch: { pinned?: boolean; hidden?: boolean }) => ({
  version: 1 as const,
  archived: false,
  pinned: patch.pinned,
  hidden: patch.hidden,
})));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { listSessions, listPersonaSessionHeads, updatePersona } }),
  useOptionalConnection: () => undefined,
}));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('./usePersonaDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./usePersonaDirectory')>();
  return { ...actual, usePersonaDirectory: () => ({ directory: directory.entries, isLoading: false, isError: false }) };
});
vi.mock('../room/CreateRoomDialog', () => ({ CreateRoomDialog: () => createElement('div', { 'data-stub-room-dialog': true }) }));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.clear();
  resetLayoutPreferencesForTests();
  navigate.mockReset();
  directory.entries = [];
  listSessions.mockReset().mockResolvedValue({ items: [] as unknown[], has_more: false });
  listPersonaSessionHeads.mockReset().mockResolvedValue({});
  updatePersona.mockClear();
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

function persona(patch: Partial<PersonaDirectoryEntry> = {}): PersonaDirectoryEntry {
  return {
    id: 'xiao-you', name: '小柚', revision: 'revision-1', archived: false,
    homeSessionId: undefined, pinned: false, hidden: false,
    life: 'idle', unreadCount: 0, unreadSessionIds: [],
    ...patch,
  } as PersonaDirectoryEntry;
}

function session(patch: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: patch.id, workspace_id: 'ws_a', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T10:00:00Z', metadata: { cwd: '/a' }, busy: false, last_seq: 1,
    ...patch,
  } as Session;
}

/** A conversation the persona owns, the way the server binds one. */
function hers(patch: Partial<Session> & Pick<Session, 'id'>, personaId = 'xiao-you'): Session {
  const base = session(patch);
  return { ...base, metadata: { ...base.metadata, bot_persona_id: personaId } } as Session;
}

async function render(
  sessions: readonly Session[] = [],
  activeSessionId?: string,
  initialPath = '/',
  seen: Record<string, number> = {},
  customQueryClient?: QueryClient,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = customQueryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient },
      createElement(I18nProvider, null,
        createElement(MemoryRouter, { initialEntries: [initialPath] },
          createElement(SidebarPersonaSection, {
            sessions, activeSessionId, seen, workspaceOptions: [], rooms: [{ id: 'room_alpha', title: '发布协作室' } as never],
          })))));
  });
  return container;
}

async function flush() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => { await new Promise((done) => { setTimeout(done, 0); }); });
  }
}

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-sidebar-persona-row]')].map(
    (row) => row.getAttribute('data-sidebar-persona-row') ?? '',
  );
}

function subthreadIds(container: HTMLElement, personaId = 'xiao-you'): string[] {
  return [...container.querySelectorAll(`[data-persona-subthreads="${personaId}"] [data-persona-subthread]`)].map(
    (el) => el.getAttribute('data-persona-subthread') ?? '',
  );
}

describe('the sidebar persona group', () => {
  it('sorts active, urgent, pinned, and recently active personas to the top when no custom order is saved, hides hidden entries, and keeps inline rows free of tagline clutter', async () => {
    directory.entries = [
      persona({ id: 'zhou', name: '小周', title: '超长设定副标题不应挤占折叠单行空间', life: 'idle', lastActivityAt: 100 }),
      persona({ id: 'you', name: '小柚', pinned: true, life: 'waiting', unreadCount: 2, unreadSessionIds: ['s1', 's2'], lastActivityAt: 9_000 }),
      persona({ id: 'gui', name: '小桂', hidden: true }),
      persona({ id: 'dou', name: '豆豆', homeSessionId: 'active_home', lastActivityAt: 5_000 }),
    ];
    const container = await render([session({ id: 'active_home' })], 'active_home');
    expect(rowIds(container)).toEqual(['dou', 'you', 'zhou']);
    const zhouPrimary = container.querySelector<HTMLButtonElement>('[data-persona-primary="zhou"]')!;
    expect(zhouPrimary.textContent).toContain('小周');
    expect(zhouPrimary.textContent).not.toContain('超长设定副标题');
    expect(zhouPrimary.getAttribute('title')).toContain('超长设定副标题不应挤占折叠单行空间');
  });

  it('reorders personas via drag-and-drop and Alt+Arrow keys and persists the custom order in localStorage', async () => {
    expect(reorderPersonaIds(['zhou', 'you', 'dou'], 'dou', 'zhou', 'before')).toEqual(['dou', 'zhou', 'you']);
    expect(orderSidebarPersonas([
      persona({ id: 'zhou', name: '小周' }),
      persona({ id: 'you', name: '小柚' }),
      persona({ id: 'dou', name: '豆豆' }),
    ], ['dou', 'zhou'])).toMatchObject([{ id: 'dou' }, { id: 'zhou' }, { id: 'you' }]);

    directory.entries = [
      persona({ id: 'zhou', name: '小周' }),
      persona({ id: 'you', name: '小柚' }),
      persona({ id: 'dou', name: '豆豆' }),
    ];
    const container = await render();
    expect(rowIds(container)).toEqual(['zhou', 'you', 'dou']);

    const sourceRow = container.querySelector<HTMLElement>('[data-sidebar-persona-row="dou"]')!;
    const targetRow = container.querySelector<HTMLElement>('[data-sidebar-persona-row="zhou"]')!;
    vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 132, left: 0, right: 240, width: 240, height: 32, x: 0, y: 100, toJSON: () => ({}),
    });

    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'move',
      setData: (type: string, val: string) => { store.set(type, val); },
      getData: (type: string) => store.get(type) ?? '',
    };

    await act(async () => {
      const startEvt = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(startEvt, 'dataTransfer', { value: dataTransfer });
      sourceRow.dispatchEvent(startEvt);
    });
    await act(async () => {
      const overEvt = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 104 });
      Object.defineProperty(overEvt, 'dataTransfer', { value: dataTransfer });
      targetRow.dispatchEvent(overEvt);
    });
    expect(targetRow.querySelector('[data-persona-drop-indicator="before"]')).not.toBeNull();

    await act(async () => {
      const dropEvt = new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 104 });
      Object.defineProperty(dropEvt, 'dataTransfer', { value: dataTransfer });
      targetRow.dispatchEvent(dropEvt);
    });

    expect(rowIds(container)).toEqual(['dou', 'zhou', 'you']);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_PERSONA_ORDER_KEY) ?? '[]')).toEqual(['dou', 'zhou', 'you']);

    // Keyboard Alt+ArrowDown moves 'dou' after 'zhou' and persists.
    const movedRow = container.querySelector<HTMLElement>('[data-sidebar-persona-row="dou"]')!;
    await act(async () => {
      movedRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    });
    expect(rowIds(container)).toEqual(['zhou', 'dou', 'you']);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_PERSONA_ORDER_KEY) ?? '[]')).toEqual(['zhou', 'dou', 'you']);

    // Remounting reads the persisted order.
    const remounted = await render();
    expect(rowIds(remounted)).toEqual(['zhou', 'dou', 'you']);
  });

  it('says nothing when there are no personas: the primary nav owns that address', async () => {
    const container = await render();
    expect(container.querySelector('[data-sidebar-personas]')).toBeNull();
  });

  it('switches directly to the most recent active conversation when clicking a persona row, or /p/:id/daily when zero threads exist', async () => {
    directory.entries = [persona({ id: 'dou-dou', name: '豆豆', homeSessionId: undefined })];
    const emptyContainer = await render([]);
    await act(async () => { emptyContainer.querySelector<HTMLElement>('[data-persona-primary="dou-dou"]')!.click(); });
    expect(navigate).toHaveBeenCalledWith('/p/dou-dou/daily');

    navigate.mockClear();
    const container = await render([
      hers({ id: 'room_member_1', updated_at: '2026-10-02T08:00:00Z', metadata: { cwd: '/a', room_persona_id: 'dou-dou', room_member_of: 'room_alpha' }, last_seq: 0 }, 'dou-dou'),
      hers({ id: 'topic_1', title: '豆豆 · 支线改稿', updated_at: '2026-10-02T12:00:00Z', last_seq: 0 }, 'dou-dou'),
    ]);
    const primary = container.querySelector<HTMLElement>('[data-persona-primary="dou-dou"]')!;
    await act(async () => { primary.click(); });
    expect(navigate).toHaveBeenCalledWith('/s/topic_1');

    // Extra threads remain reachable through the count/chevron disclosure.
    const toggle = container.querySelector<HTMLElement>('[data-persona-switcher-toggle="dou-dou"][data-persona-thread-count="2"]')!;
    await act(async () => { toggle.click(); });
    expect(subthreadIds(container, 'dou-dou')).toEqual(['topic_1', 'room_member_1']);
  });

  it('sends the name to the stable daily address instead of a fixed session', async () => {
    directory.entries = [persona({ homeSessionId: 'home_lin' })];
    const container = await render([session({ id: 'home_lin' })], 'home_lin');
    const row = container.querySelector<HTMLElement>('[data-persona-primary="xiao-you"]')!;
    expect(row.getAttribute('aria-current')).toBe('page');
    await act(async () => { row.click(); });
    expect(navigate).toHaveBeenCalledWith('/p/xiao-you/daily');
  });

  it('starts a new conversation directly from the inline + button', async () => {
    directory.entries = [persona({ id: 'xiao-you', name: '小柚' })];
    const container = await render([session({ id: 'current_s', workspace_id: 'ws_main' })], 'current_s');
    const newThreadBtn = container.querySelector<HTMLButtonElement>('[data-persona-new-thread="xiao-you"]')!;
    await act(async () => { newThreadBtn.click(); });
    expect(navigate).toHaveBeenCalledWith('/new?persona=xiao-you&workspace=ws_main');
  });

  it('takes one unread conversation straight there and expands all inline subthreads when there are several', async () => {
    directory.entries = [persona({ unreadCount: 1, unreadSessionIds: ['topic_9'], life: 'done' })];
    const single = await render([hers({ id: 'topic_9', last_seq: 5 })]);
    const count = single.querySelector<HTMLElement>('[data-persona-unread-count="1"]')!;
    await act(async () => { count.click(); });
    expect(navigate).toHaveBeenCalledWith('/s/topic_9');
    expect(single.querySelector('[data-persona-switcher]')).toBeNull();

    directory.entries = [persona({ unreadCount: 3, unreadSessionIds: ['topic_9', 'topic_8', 'topic_7'], life: 'done' })];
    const several = await render([
      hers({ id: 'topic_9', last_seq: 5 }),
      hers({ id: 'topic_8', last_seq: 5 }),
      hers({ id: 'topic_7', last_seq: 5 }),
    ]);
    await act(async () => { several.querySelector<HTMLElement>('[data-persona-unread-count="3"]')!.click(); });
    expect(subthreadIds(several)).toEqual(['topic_9', 'topic_8', 'topic_7']);
    expect(several.querySelector('[data-persona-switcher]')).toBeNull();
  });
});

describe('reliable persona conversation discovery and unified inline expansion', () => {
  it('fetches a single aggregate /personas/session-heads payload, stays immune to ["sessions"] invalidation storms, and expands cold conversations inline', async () => {
    expect(personaSwitcherQueryKey('xiao-you')[0]).not.toBe('sessions');
    directory.entries = [
      persona({ id: 'xiao-you', name: '小柚', homeSessionId: 'home_you' }),
      persona({ id: 'dou-dou', name: '豆豆' }),
      persona({ id: 'mi-li', name: '米粒' }),
    ];
    listPersonaSessionHeads.mockResolvedValue({
      'xiao-you': {
        total: 5,
        items: [
          hers({ id: 'home_you', title: '小柚', updated_at: '2026-10-01T10:00:00Z' }),
          hers({ id: 'topic_loaded', title: '小柚 · 已在首屏切片', updated_at: '2026-10-03T10:00:00Z' }),
          hers({ id: 'topic_cold_1', title: '小柚 · 冷归档对话一', updated_at: '2026-09-12T10:00:00Z' }),
          hers({ id: 'topic_cold_2', title: '小柚 · 冷归档对话二', updated_at: '2026-08-05T10:00:00Z' }),
          hers({ id: 'topic_cold_3', title: '小柚 · 冷归档对话三', updated_at: '2026-07-05T10:00:00Z' }),
        ],
      },
      'dou-dou': {
        total: 2,
        items: [
          hers({ id: 'dou_cold_1', title: '豆豆 · 改稿一', last_seq: 0 }, 'dou-dou'),
          hers({ id: 'dou_cold_2', title: '豆豆 · 改稿二', last_seq: 0 }, 'dou-dou'),
        ],
      },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await render(
      [hers({ id: 'topic_loaded', title: '小柚 · 已在首屏切片', updated_at: '2026-10-03T10:00:00Z' })],
      undefined,
      '/',
      { home_you: 1, topic_loaded: 1, topic_cold_1: 1, topic_cold_2: 1, topic_cold_3: 1 },
      queryClient,
    );
    await flush();

    // 1 single aggregate request across all 3 personas; 0 per-persona listSessions calls!
    expect(listPersonaSessionHeads).toHaveBeenCalledTimes(1);
    expect(listPersonaSessionHeads).toHaveBeenCalledWith(
      { per_persona_limit: 10, include_private: false, private_only: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(listSessions).not.toHaveBeenCalled();

    // Alt+Tab `invalidateQueries({ queryKey: ['sessions'] })` must NOT trigger any persona head or switcher refetch.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    });
    await flush();
    expect(listPersonaSessionHeads).toHaveBeenCalledTimes(1);
    expect(listSessions).not.toHaveBeenCalled();

    // Total conversations = home_you (1) + 4 non-home topics = 5; inline preview shows up to 3 before +N.
    expect(SIDEBAR_PERSONA_INLINE_THREAD_LIMIT).toBe(3);
    const toggle = container.querySelector<HTMLButtonElement>('[data-persona-switcher-toggle="xiao-you"]')!;
    expect(toggle.getAttribute('data-persona-thread-count')).toBe('5');

    // Idle persona starts collapsed; clicking the count chevron unfolds inline without any floating popover.
    expect(container.querySelector('[data-persona-subthreads="xiao-you"]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-persona-switcher]')).toBeNull();
    expect(subthreadIds(container)).toEqual(['topic_loaded', 'topic_cold_1', 'topic_cold_2']);

    // Clicking "+1 · All conversations" expands the remaining cold conversation inline in place without needing listSessions when total <= head items.
    const moreBtn = container.querySelector<HTMLButtonElement>('[data-persona-subthreads-more="xiao-you"]')!;
    expect(moreBtn.textContent).toContain('+1');
    await act(async () => { moreBtn.click(); });
    expect(subthreadIds(container)).toEqual(['topic_loaded', 'topic_cold_1', 'topic_cold_2', 'topic_cold_3']);
    expect(listSessions).not.toHaveBeenCalled();

    // Clicking Show less returns to the compact 3-thread preview, and clicking the chevron collapses completely.
    const lessBtn = container.querySelector<HTMLButtonElement>('[data-persona-subthreads-less="xiao-you"]')!;
    await act(async () => { lessBtn.click(); });
    expect(subthreadIds(container)).toEqual(['topic_loaded', 'topic_cold_1', 'topic_cold_2']);

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-persona-subthreads="xiao-you"]')).toBeNull();
  });

  it('strictly obeys filters.private ("hide" by default, "include", and "only") so private sessions never leak into counts, unread badges, or running expansion when hidden', async () => {
    const publicRead = hers({ id: 'topic_public_read', title: '小柚 · 公开已读', last_seq: 3, updated_at: '2026-11-17T10:00:00Z' });
    const privateRunning = hers({
      id: 'topic_private_running',
      title: '小柚 · 绝密进行中标题',
      private: true,
      busy: true,
      last_seq: 8,
      updated_at: '2026-11-18T10:00:00Z',
    });
    const privateUnread = hers({
      id: 'topic_private_unread',
      title: '小柚 · 绝密未读标题',
      private: true,
      last_seq: 5,
      updated_at: '2026-11-16T10:00:00Z',
    });
    const coldUnread = hers({
      id: 'topic_cold_unread',
      title: '小柚 · 公开冷未读',
      last_seq: 5,
      updated_at: '2026-10-12T10:00:00Z',
    });
    const seen = {
      home_you: 4,
      topic_public_read: 3,
      topic_cold_seen: 6,
      topic_cold_unread: 2,
      topic_private_unread: 1,
    };

    // 1. Default (`filters.private` omitted => 'hide'): private running/unread sessions must NOT leak!
    directory.entries = buildPersonaDirectory(
      [{ id: 'xiao-you', name: '小柚', revision: 'rev-1', archived: false, homeSessionId: 'home_you' }],
      [],
      [publicRead, privateRunning, privateUnread],
      seen,
    );
    listPersonaSessionHeads.mockResolvedValue({
      'xiao-you': {
        total: 3,
        items: [
          hers({ id: 'home_you', title: '小柚', last_seq: 4, updated_at: '2026-11-10T10:00:00Z' }),
          publicRead,
          hers({ id: 'topic_cold_seen', title: '小柚 · 已读冷归档', last_seq: 6, updated_at: '2026-09-01T10:00:00Z' }),
        ],
      },
    });
    const hiddenContainer = await render([publicRead, privateRunning, privateUnread], undefined, '/', seen);
    await flush();
    expect(listPersonaSessionHeads).toHaveBeenLastCalledWith(
      { per_persona_limit: 10, include_private: false, private_only: undefined },
      expect.any(Object),
    );
    expect(hiddenContainer.querySelector('[data-persona-unread-count]')).toBeNull();
    expect(hiddenContainer.querySelector('[data-persona-subthreads="xiao-you"]')).toBeNull();
    expect(hiddenContainer.textContent).not.toContain('绝密进行中标题');
    expect(hiddenContainer.textContent).not.toContain('绝密未读标题');
    expect(hiddenContainer.querySelector('[data-persona-switcher-toggle="xiao-you"]')?.getAttribute('data-persona-thread-count')).toBe('3');

    // 2. `filters.private: 'include'`: preserves unread status on cold and private serverItems without misclassifying seen/empty threads.
    writeLayoutPreferences({ filters: { status: [], workspaces: [], archived: 'hide', private: 'include' } });
    directory.entries = buildPersonaDirectory(
      [{ id: 'xiao-you', name: '小柚', revision: 'rev-1', archived: false, homeSessionId: 'home_you' }],
      [],
      [publicRead],
      seen,
    );
    listPersonaSessionHeads.mockResolvedValue({
      'xiao-you': {
        total: 6,
        items: [
          hers({ id: 'home_you', title: '小柚', last_seq: 4, updated_at: '2026-11-10T10:00:00Z' }),
          publicRead,
          hers({ id: 'topic_cold_seen', title: '小柚 · 已读冷归档', last_seq: 6, updated_at: '2026-09-01T10:00:00Z' }),
          hers({ id: 'topic_cold_empty', title: '小柚 · 空草稿归档', last_seq: 0, updated_at: '2026-08-01T10:00:00Z' }),
          coldUnread,
          privateUnread,
        ],
      },
    });

    const includedContainer = await render([publicRead], undefined, '/', seen);
    await flush();
    expect(listPersonaSessionHeads).toHaveBeenLastCalledWith(
      { per_persona_limit: 10, include_private: true, private_only: undefined },
      expect.any(Object),
    );
    expect(includedContainer.querySelector('[data-persona-unread-count="2"]')).not.toBeNull();
    expect(subthreadIds(includedContainer)).toEqual(['topic_private_unread', 'topic_cold_unread']);
    const lifeMarks = [...includedContainer.querySelectorAll('[data-persona-subthreads="xiao-you"] [data-life]')].map((el) => el.getAttribute('data-life'));
    expect(lifeMarks).toEqual(['done', 'done']);
    expect(includedContainer.querySelector('[data-persona-subthreads-more="xiao-you"]')?.textContent).toContain('+3');

    // 3. `filters.private: 'only'`: requests private_only: true and excludes public conversations.
    writeLayoutPreferences({ filters: { status: [], workspaces: [], archived: 'hide', private: 'only' } });
    listPersonaSessionHeads.mockResolvedValue({
      'xiao-you': {
        total: 1,
        items: [privateUnread],
      },
    });
    const onlyPrivateContainer = await render([publicRead, privateUnread], undefined, '/', seen);
    await flush();
    expect(listPersonaSessionHeads).toHaveBeenLastCalledWith(
      { per_persona_limit: 10, include_private: true, private_only: true },
      expect.any(Object),
    );
    expect(onlyPrivateContainer.querySelector('[data-persona-unread-count="1"]')).not.toBeNull();
    expect(subthreadIds(onlyPrivateContainer)).toEqual(['topic_private_unread']);
    expect(onlyPrivateContainer.querySelector('[data-persona-switcher-toggle="xiao-you"]')?.getAttribute('data-persona-thread-count')).toBe('1');
  });

  it('keeps loaded conversations visible while server queries are still in flight or reject', async () => {
    directory.entries = [persona({ id: 'xiao-you', name: '小柚', homeSessionId: 'home_you' })];
    listPersonaSessionHeads.mockReturnValue(new Promise(() => {}));
    const container = await render([
      hers({ id: 'home_you', title: '小柚' }),
      hers({ id: 'topic_loaded', title: '小柚 · 本地已载入' }),
    ], 'topic_loaded');
    await flush();

    expect(container.querySelector('[data-persona-thread-count="2"]')).not.toBeNull();
    expect(subthreadIds(container)).toEqual(['topic_loaded']);
  });
});

describe('collapsible and count-bounded persona group', () => {
  it('removes inner scroll, caps folded preview at 5 with active/urgent/pinned/recent priority, and persists expand/collapse', async () => {
    expect(SIDEBAR_PERSONA_PREVIEW_LIMIT).toBe(5);
    directory.entries = [
      persona({ id: 'p-alpha', name: 'Alpha', lastActivityAt: 100 }),
      persona({ id: 'p-bravo', name: 'Bravo', lastActivityAt: 200 }),
      persona({ id: 'p-charlie', name: 'Charlie', lastActivityAt: 300 }),
      persona({ id: 'p-delta', name: 'Delta', pinned: true, lastActivityAt: 50 }),
      persona({ id: 'p-echo', name: 'Echo', life: 'waiting', unreadCount: 2, unreadSessionIds: ['s1', 's2'] }),
      persona({ id: 'p-foxtrot', name: 'Foxtrot', homeSessionId: 'active-home' }),
      persona({ id: 'p-golf', name: 'Golf', life: 'working', lastActivityAt: 150 }),
      persona({ id: 'p-hotel', name: 'Hotel · Fast', life: 'done', unreadCount: 1, unreadSessionIds: ['s3'], lastActivityAt: 900 }),
      persona({ id: 'p-india', name: 'India', lastActivityAt: 50 }),
      persona({ id: 'p-juliet', name: 'Juliet', lastActivityAt: 400 }),
    ];
    const container = await render([session({ id: 'active-home' })], 'active-home');
    const wrapper = container.querySelector<HTMLElement>('[data-sidebar-personas]')!;
    expect(wrapper.className).not.toContain('overflow-y-auto');
    expect(wrapper.className).not.toContain('max-h-');

    expect(rowIds(container)).toEqual([
      'p-foxtrot',
      'p-echo',
      'p-golf',
      'p-hotel',
      'p-delta',
    ]);

    const moreBtn = container.querySelector<HTMLButtonElement>('[data-sidebar-personas-more="more"]')!;
    expect(moreBtn).not.toBeNull();
    expect(moreBtn.textContent).toContain('5');
    await act(async () => { moreBtn.click(); });
    expect(container.querySelectorAll('[data-sidebar-persona-row]')).toHaveLength(10);
    expect(container.querySelector('[data-sidebar-personas-more="less"]')).not.toBeNull();

    // Remounting preserves the persisted show-all preference.
    const remounted = await render([session({ id: 'active-home' })], 'active-home');
    expect(remounted.querySelectorAll('[data-sidebar-persona-row]')).toHaveLength(10);

    const headerToggle = container.querySelector<HTMLButtonElement>('[data-sidebar-personas-toggle]')!;
    expect(headerToggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { headerToggle.click(); });
    expect(headerToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-sidebar-persona-row]')).toHaveLength(0);
    expect(container.querySelector('[data-sidebar-personas-attention]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-personas-collapsed-unread="3"]')).not.toBeNull();
  });

  it('offers New conversation, Pin (moving persona to top of savedOrder), Hide from list, and Persona settings actions from the row menu', async () => {
    directory.entries = [
      persona({ id: 'zhou', name: '小周', pinned: false }),
      persona({ id: 'xiao-you', name: '小柚', pinned: false }),
    ];
    const container = await render();
    expect(rowIds(container)).toEqual(['zhou', 'xiao-you']);

    const menuToggle = container.querySelector<HTMLButtonElement>('[data-persona-menu-toggle="xiao-you"]')!;
    await act(async () => { menuToggle.click(); });
    const menu = document.body.querySelector('[data-persona-row-menu]')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelector('[data-menu-item="new-topic"]')).not.toBeNull();

    const pinItem = menu.querySelector<HTMLButtonElement>('[data-menu-item="pin"]')!;
    await act(async () => { pinItem.click(); });
    await flush();
    expect(updatePersona).toHaveBeenCalledWith('xiao-you', { pinned: true });
    expect(rowIds(container)).toEqual(['xiao-you', 'zhou']);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_PERSONA_ORDER_KEY) ?? '[]')).toEqual(['xiao-you', 'zhou']);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-persona-menu-toggle="xiao-you"]')!.click(); });
    const menu2 = document.body.querySelector('[data-persona-row-menu]')!;
    const hideItem = menu2.querySelector<HTMLButtonElement>('[data-menu-item="hide"]')!;
    await act(async () => { hideItem.click(); });
    await flush();
    expect(updatePersona).toHaveBeenCalledWith('xiao-you', { hidden: true });
  });

  it('expands inline topic threads for active or attention personas while keeping idle multi-thread personas collapsed until toggled', async () => {
    directory.entries = [
      persona({ id: 'contest-coach', name: '教练 · 赛事顾问', homeSessionId: 'session_home', pinned: true }),
      persona({
        id: 'fact-check',
        name: '米粒 · 事实核查',
        homeSessionId: 'session_fact_home',
        pinned: true,
        life: 'done',
        unreadCount: 1,
        unreadSessionIds: ['session_fact_unread'],
      }),
      persona({ id: 'archive-scribe', name: '归档 · 历史搭子', homeSessionId: 'session_idle_home', pinned: true }),
    ];
    const container = await render([
      hers({ id: 'session_home', title: '教练 · 赛事顾问', updated_at: '2026-11-16T08:00:00Z' }, 'contest-coach'),
      hers({ id: 'session_radar', title: '教练 · 赛事顾问｜全域赛程梳理', updated_at: '2026-11-17T09:30:00Z' }, 'contest-coach'),
      hers({ id: 'session_review', title: '教练 · 赛事顾问 — 方案复盘', updated_at: '2026-11-17T08:00:00Z' }, 'contest-coach'),
      hers({ id: 'session_fact_home', title: '米粒 · 事实核查', updated_at: '2026-11-16T07:00:00Z' }, 'fact-check'),
      hers({ id: 'session_fact_unread', title: '米粒 · 事实核查｜证书续期要多久', updated_at: '2026-11-17T09:00:00Z' }, 'fact-check'),
      hers({ id: 'session_fact_idle', title: '米粒 · 事实核查｜旧归档核对', updated_at: '2026-11-15T09:00:00Z' }, 'fact-check'),
      hers({ id: 'session_idle_home', title: '归档 · 历史搭子', updated_at: '2026-11-10T08:00:00Z' }, 'archive-scribe'),
      hers({ id: 'session_idle_1', title: '归档 · 历史搭子｜十月周报', updated_at: '2026-11-11T08:00:00Z' }, 'archive-scribe'),
      hers({ id: 'session_idle_2', title: '归档 · 历史搭子｜九月周报', updated_at: '2026-11-09T08:00:00Z' }, 'archive-scribe'),
    ], 'session_radar');

    expect(container.querySelectorAll('[data-persona-thread-count="3"]')).toHaveLength(3);

    const activeSubthreads = [...container.querySelectorAll<HTMLButtonElement>('[data-persona-subthreads="contest-coach"] [data-persona-subthread]')];
    expect(activeSubthreads.map((item) => item.getAttribute('data-persona-subthread'))).toEqual([
      'session_radar',
      'session_review',
    ]);
    expect(activeSubthreads[0]?.textContent).toContain('全域赛程梳理');
    expect(activeSubthreads[0]?.getAttribute('aria-current')).toBe('page');

    const unreadSubthreads = [...container.querySelectorAll<HTMLButtonElement>('[data-persona-subthreads="fact-check"] [data-persona-subthread]')];
    expect(unreadSubthreads.map((item) => item.getAttribute('data-persona-subthread'))).toEqual([
      'session_fact_unread',
    ]);
    expect(container.querySelector('[data-persona-subthreads-more="fact-check"]')?.textContent).toContain('+1');

    // Idle persona starts collapsed, and clicking its count toggle expands inline instead of opening a popover.
    expect(container.querySelector('[data-persona-subthreads="archive-scribe"]')).toBeNull();
    const idleToggle = container.querySelector<HTMLButtonElement>('[data-persona-switcher-toggle="archive-scribe"][data-persona-thread-count="3"]')!;
    await act(async () => { idleToggle.click(); });
    expect(subthreadIds(container, 'archive-scribe')).toEqual(['session_idle_1', 'session_idle_2']);

    await act(async () => { activeSubthreads[1]!.click(); });
    expect(navigate).toHaveBeenCalledWith('/s/session_review');
  });
});
