// @vitest-environment jsdom

/**
 * Sidebar Bots group: hidden Bots stay off, pinned lead, a Bot's home session
 * state shows on its row, a persona becomes a Bot from the group's + menu,
 * and the room create entry lives in the same header while Bot mode is on.
 * Rooms themselves list as conversation rows in the main session list.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, PersonaSummary, Session } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { isBotOrRoomSession, SidebarBotRoomGroups, visibleBots } from './SidebarBotRoomGroups';

const bots = vi.hoisted(() => ({ list: vi.fn(), enable: vi.fn(), ensureHomeSession: vi.fn(), update: vi.fn() }));
const rooms = vi.hoisted(() => ({ list: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({
  klient: { rest: { bots, rooms } },
  listPersonas: vi.fn(),
  getPersonaAvatar: vi.fn(async () => null),
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client }),
}));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));

const PERSONAS: PersonaSummary[] = [
  { id: 'lin-lan', name: '林岚', title: '发布协调', revision: 'r', archived: false },
  { id: 'a-che', name: '阿澈', title: '写作', revision: 'r', archived: false },
  { id: 'xiao-lan', name: '小蓝', title: '调研', revision: 'r', archived: false },
  { id: 'lao-zhou', name: '老周', title: '审校', revision: 'r', archived: false },
];
const BOTS: BotSummary[] = [
  { personaId: 'a-che', name: '阿澈', title: '写作', homeSessionId: 'home_che', pinned: false, hidden: false },
  { personaId: 'lin-lan', name: '林岚', title: '发布协调', homeSessionId: 'home_lin', pinned: true, hidden: false },
  { personaId: 'xiao-lan', name: '小蓝', title: '调研', homeSessionId: 'home_lan', pinned: false, hidden: true },
];

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, busy: false, metadata: { cwd: 'C:/' }, updated_at: '2026-10-01T00:00:00.000Z', ...extra } as Session;
}

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const fn of [...Object.values(bots), rooms.list, navigate]) fn.mockReset();
  bots.list.mockResolvedValue(BOTS);
  client.listPersonas.mockResolvedValue(PERSONAS);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(sessions: Session[] = []): Promise<HTMLDivElement> {
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
            <SidebarBotRoomGroups sessions={sessions} activeSessionId="home_lin" seen={{}} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

describe('sidebar Bot helpers', () => {
  it('orders pinned first, drops hidden, and recognises Bot / room sessions', () => {
    expect(visibleBots(BOTS).map((bot) => bot.personaId)).toEqual(['lin-lan', 'a-che']);
    expect(isBotOrRoomSession(session('a', { metadata: { cwd: 'C:/', bot_persona_id: 'lin-lan' } }))).toBe(true);
    expect(isBotOrRoomSession(session('b', { metadata: { cwd: 'C:/', room_member_of: 'release-031' } }))).toBe(true);
    expect(isBotOrRoomSession(session('c'))).toBe(false);
  });
});

describe('SidebarBotRoomGroups', () => {
  it('lists visible Bots with their home state', async () => {
    const container = await mount([session('home_che', { busy: true }), session('home_lin', { pending_interaction: 'question' })]);
    const rows = [...container.querySelectorAll('[data-sidebar-bot]')];
    expect(rows.map((row) => row.getAttribute('data-sidebar-bot'))).toEqual(['lin-lan', 'a-che']);
    expect(rows[0]?.getAttribute('aria-current')).toBe('page');
    expect(rows[0]?.textContent).toContain('发布协调');
    await act(async () => { (rows[1] as HTMLButtonElement).click(); });
    await flush();
    expect(navigate).toHaveBeenCalledWith('/s/home_che');
  });

  it('keeps the room create entry in the Bot header while bots exist', async () => {
    const container = await mount();
    const create = container.querySelector<HTMLButtonElement>('[data-room-create]');
    expect(create).not.toBeNull();
    // Rooms list as conversation rows now, not as a group here.
    expect(container.querySelector('[data-sidebar-rooms]')).toBeNull();
    expect(container.querySelector('[data-sidebar-room]')).toBeNull();
    await act(async () => { create!.click(); });
    await flush();
    expect(document.querySelector('[data-create-room-submit]')).not.toBeNull();
  });

  it('hides the room create entry when no Bot exists (Bot mode off)', async () => {
    bots.list.mockResolvedValue([]);
    client.listPersonas.mockResolvedValue([]);
    const container = await mount();
    expect(container.querySelector('[data-room-create]')).toBeNull();
  });

  it('turns a persona into a Bot from the + menu and opens its home', async () => {
    bots.enable.mockResolvedValue({ personaId: 'lao-zhou', name: '老周', homeSessionId: 'home_zhou', pinned: false, hidden: false });
    const container = await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-bot-enable-toggle]')?.click(); });
    const options = [...document.querySelectorAll('[data-enable-bot]')].map((node) => node.getAttribute('data-enable-bot'));
    expect(options).toEqual(['lao-zhou']);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-enable-bot="lao-zhou"]')?.click(); });
    await flush();
    expect(bots.enable).toHaveBeenCalledWith('lao-zhou');
    expect(navigate).toHaveBeenCalledWith('/s/home_zhou');
  });

  it('renders nothing when the Bot API is unavailable', async () => {
    bots.list.mockRejectedValue(new Error('Bot mode is disabled'));
    const container = await mount();
    expect(container.querySelector('[data-sidebar-bot-rooms]')).toBeNull();
  });
});
