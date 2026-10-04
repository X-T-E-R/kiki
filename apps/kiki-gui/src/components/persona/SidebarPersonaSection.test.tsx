// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import type { PersonaDirectoryEntry } from './usePersonaDirectory';
import { SidebarPersonaSection } from './SidebarPersonaSection';

const navigate = vi.fn();
const directory = vi.hoisted(() => ({ entries: [] as unknown[] }));
const listSessions = vi.hoisted(() => vi.fn(async () => ({ items: [] as unknown[], has_more: false })));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { listSessions } }),
  useOptionalConnection: () => undefined,
}));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));
vi.mock('./usePersonaDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./usePersonaDirectory')>();
  return { ...actual, usePersonaDirectory: () => ({ directory: directory.entries, isLoading: false, isError: false }) };
});
vi.mock('./PersonaConversationSwitcher', () => ({
  PersonaConversationSwitcher: ({
    persona,
    sessions,
    status,
    onClose,
  }: {
    readonly persona: { id: string };
    readonly sessions: readonly Session[];
    readonly status?: { readonly loading?: boolean; readonly error?: string };
    readonly onClose: () => void;
  }) => createElement('div', { 'data-stub-switcher': persona.id },
    createElement('output', { 'data-stub-switcher-sessions': '' }, JSON.stringify(sessions.map((item) => item.id))),
    createElement('output', { 'data-stub-switcher-status': '' },
      status === undefined
        ? 'none'
        : status.error !== undefined
          ? 'failed'
          : status.loading === true ? 'loading' : 'ready'),
    createElement('button', { 'data-stub-switcher-close': persona.id, onClick: onClose })),
}));
vi.mock('../room/CreateRoomDialog', () => ({ CreateRoomDialog: () => createElement('div', { 'data-stub-room-dialog': true }) }));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  navigate.mockReset();
  directory.entries = [];
  listSessions.mockReset().mockResolvedValue({ items: [], has_more: false });
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

function persona(patch: Partial<PersonaDirectoryEntry> = {}): PersonaDirectoryEntry {
  return {
    id: 'lin-lan', name: '小岚', revision: 'revision-1', archived: false,
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
function hers(patch: Partial<Session> & Pick<Session, 'id'>, personaId = 'lin-lan'): Session {
  const base = session(patch);
  return { ...base, metadata: { ...base.metadata, bot_persona_id: personaId } } as Session;
}

async function render(sessions: readonly Session[] = [], activeSessionId?: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null, createElement(SidebarPersonaSection, {
      sessions, activeSessionId, seen: {}, workspaceOptions: [], rooms: [],
    }))));
  });
  return container;
}

async function flush() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => { await new Promise((done) => { setTimeout(done, 0); }); });
  }
}

const switcherSessions = (container: HTMLElement) =>
  JSON.parse(container.querySelector('[data-stub-switcher-sessions]')?.textContent ?? '[]') as string[];
const switcherStatus = (container: HTMLElement) =>
  container.querySelector('[data-stub-switcher-status]')?.textContent;

async function openSwitcher(container: HTMLElement, personaId = 'lin-lan') {
  await act(async () => { container.querySelector<HTMLElement>(`[data-persona-switcher-toggle="${personaId}"]`)!.click(); });
}

describe('the sidebar persona group', () => {
  it('gives every persona one row, pinned first, and hides the hidden ones', async () => {
    directory.entries = [
      persona({ id: 'zhou', name: '小周' }),
      persona({ id: 'lan', name: '小岚', pinned: true }),
      persona({ id: 'gui', name: '小桂', hidden: true }),
    ];
    const container = await render();
    expect([...container.querySelectorAll('[data-sidebar-persona-row]')].map((row) => row.getAttribute('data-sidebar-persona-row')))
      .toEqual(['lan', 'zhou']);
  });

  it('says nothing when there are no personas: the primary nav owns that address', async () => {
    const container = await render();
    expect(container.querySelector('[data-sidebar-personas]')).toBeNull();
  });

  it('sends the name to the stable daily address instead of a fixed session', async () => {
    directory.entries = [persona({ homeSessionId: 'home_lin' })];
    const container = await render([session({ id: 'home_lin' })], 'home_lin');
    const row = container.querySelector<HTMLElement>('[data-sidebar-persona-row="lin-lan"] button')!;
    expect(row.getAttribute('aria-current')).toBe('page');
    await act(async () => { row.click(); });
    // The pointer, not the snapshot: /p/:id/daily resolves the current home.
    expect(navigate).toHaveBeenCalledWith('/p/lin-lan/daily');
  });

  it('opens the shared switcher from the row-end control, and closes it again', async () => {
    directory.entries = [persona()];
    const container = await render();
    const toggle = container.querySelector<HTMLElement>('[data-persona-switcher-toggle="lin-lan"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(container.querySelector('[data-stub-switcher="lin-lan"]')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { container.querySelector<HTMLElement>('[data-stub-switcher-close="lin-lan"]')!.click(); });
    expect(container.querySelector('[data-stub-switcher="lin-lan"]')).toBeNull();
  });

  it('takes one unread conversation straight there and asks which one when there are several', async () => {
    directory.entries = [persona({ unreadCount: 1, unreadSessionIds: ['topic_9'], life: 'done' })];
    const single = await render();
    const count = single.querySelector<HTMLElement>('[data-persona-unread-count="1"]')!;
    await act(async () => { count.click(); });
    expect(navigate).toHaveBeenCalledWith('/s/topic_9');
    expect(single.querySelector('[data-stub-switcher]')).toBeNull();

    directory.entries = [persona({ unreadCount: 2, unreadSessionIds: ['topic_9', 'topic_8'], life: 'done' })];
    const several = await render();
    await act(async () => { several.querySelector<HTMLElement>('[data-persona-unread-count="2"]')!.click(); });
    expect(several.querySelector('[data-stub-switcher="lin-lan"]')).not.toBeNull();
  });
});

/**
 * Which conversations belong to a persona is the server's answer. The sidebar
 * hands this component one page of every session, grown only when someone
 * presses "load more", so a persona's older conversation is usually not in it
 * — the panel has to ask, and only when it opens.
 */
describe('the sidebar switcher list', () => {
  it('reads the conversations from the server, including ones outside the loaded window', async () => {
    directory.entries = [persona()];
    // The global window holds one of hers. The other exists only on the server.
    listSessions.mockResolvedValue({ items: [hers({ id: 'topic_loaded' }), hers({ id: 'topic_cold' })], has_more: false });
    const container = await render([hers({ id: 'topic_loaded' })]);
    expect(listSessions).not.toHaveBeenCalled();

    await openSwitcher(container);
    await flush();

    expect(listSessions).toHaveBeenCalledWith({ persona: 'lin-lan', page_size: 100 });
    expect(switcherSessions(container)).toEqual(['topic_loaded', 'topic_cold']);
    expect(switcherStatus(container)).toBe('ready');
  });

  it('keeps the loaded rows while that read is still in flight', async () => {
    directory.entries = [persona()];
    listSessions.mockReturnValue(new Promise(() => {}));
    const container = await render([hers({ id: 'topic_loaded' })]);

    await openSwitcher(container);
    await flush();

    // An empty panel for a beat reads as "this persona has none".
    expect(switcherSessions(container)).toEqual(['topic_loaded']);
    expect(switcherStatus(container)).toBe('loading');
  });

  it('does not pass an empty list off as a persona without conversations', async () => {
    directory.entries = [persona()];
    listSessions.mockRejectedValue(new Error('Session index is building'));
    const container = await render();

    await openSwitcher(container);
    await flush();

    expect(switcherStatus(container)).toBe('failed');
  });

  it('asks nothing until the panel is opened, and again per persona, not per row', async () => {
    directory.entries = [persona(), persona({ id: 'zhou', name: '小周' })];
    const container = await render([session({ id: 'topic_loaded' })]);

    // Two personas on screen, panel closed: no read, no prefetch.
    expect(listSessions).not.toHaveBeenCalled();
    await openSwitcher(container);
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);

    await openSwitcher(container, 'zhou');
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith({ persona: 'zhou', page_size: 100 });
  });
});
