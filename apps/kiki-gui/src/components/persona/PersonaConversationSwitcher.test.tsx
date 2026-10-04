// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session, Workspace } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { PersonaConversationSwitcher } from './PersonaConversationSwitcher';
import type { PersonaDirectoryEntry } from './usePersonaDirectory';

const navigate = vi.fn();
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => navigate }));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  navigate.mockReset();
  // The switcher's copy is Chinese in the product's default locale.
  localStorage.setItem('kiki.locale', 'zh');
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

function persona(patch: Partial<PersonaDirectoryEntry> = {}): PersonaDirectoryEntry {
  return {
    id: 'lin-lan', name: '小岚', revision: 'revision-1', archived: false,
    homeSessionId: 'home_lin', pinned: false, hidden: false,
    life: 'idle', unreadCount: 0, unreadSessionIds: [],
    ...patch,
  } as PersonaDirectoryEntry;
}

function session(patch: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: patch.id, workspace_id: 'ws_a', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T10:00:00Z', metadata: { cwd: '/a' }, busy: false, last_seq: 3,
    ...patch,
  } as Session;
}

const workspaces: readonly Workspace[] = [
  { id: 'ws_a', name: 'EasyAgent', root: '/a', created_at: '', last_opened_at: '', pinned: false, session_count: 0, isGit: false },
];

interface Rendered {
  readonly container: HTMLDivElement;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly anchor: HTMLButtonElement;
}

async function render(overrides: {
  readonly persona?: PersonaDirectoryEntry;
  readonly sessions?: readonly Session[];
  readonly status?: { readonly loading?: boolean; readonly error?: string };
  readonly activeSessionId?: string;
  readonly roomNames?: ReadonlyMap<string, string>;
} = {}): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.append(container);
  const anchor = document.createElement('button');
  anchor.textContent = 'anchor';
  document.body.append(anchor);
  const onClose = vi.fn();
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null, createElement(PersonaConversationSwitcher, {
      anchor,
      persona: overrides.persona ?? persona(),
      sessions: overrides.sessions ?? [],
      status: overrides.status,
      activeSessionId: overrides.activeSessionId,
      workspaceOptions: workspaces,
      seen: {},
      roomNames: overrides.roomNames,
      onClose,
    }))));
  });
  return { container, onClose, anchor };
}

const menuItems = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/** React reads `value` through its own tracker; the prototype setter is what a typist triggers. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the honest tests', () => {
  it('pins the daily conversation first, opens its draft when there is no home yet, and says so', async () => {
    const fresh = await render({ persona: persona({ homeSessionId: undefined }), sessions: [
      session({ id: 'topic_1', title: '排查构建' }),
    ] });
    expect(menuItems(fresh.container)[0]?.dataset['conversationItem']).toBe('daily-draft');
    expect(menuItems(fresh.container)[0]?.textContent).toContain('开始第一段日常对话');

    await act(async () => { menuItems(fresh.container)[0]?.click(); });
    // The stable address, not a session that does not exist yet.
    expect(navigate).toHaveBeenCalledWith('/p/lin-lan/daily');
  });

  it('sends the home row to the home session and marks the current conversation on paper', async () => {
    const rendered = await render({
      sessions: [
        session({ id: 'home_lin', title: '日常', updated_at: '2026-10-02T09:00:00Z' }),
        session({ id: 'topic_1', title: '排查构建', updated_at: '2026-10-02T10:00:00Z' }),
      ],
      activeSessionId: 'topic_1',
    });
    const [daily, topic] = menuItems(rendered.container);
    expect(daily?.getAttribute('aria-current')).toBeNull();
    expect(topic?.getAttribute('aria-current')).toBe('true');
    // The selected row is the paper sheet, not a colour block.
    expect(topic?.className).toContain('row-interactive');
    expect(topic?.textContent).toContain('排查构建');
    expect(topic?.textContent).toContain('EasyAgent');

    await act(async () => { daily?.click(); });
    expect(navigate).toHaveBeenCalledWith('/s/home_lin');
  });

  it('opens the room for a room seat instead of the bare member session, and names it', async () => {
    const rendered = await render({
      sessions: [session({ id: 'room_member_1', title: 'room_alpha_guide_ab12', metadata: { cwd: '/a', room_member_of: 'room_alpha' } })],
      roomNames: new Map([['room_alpha', '发布房间']]),
    });
    const row = menuItems(rendered.container).find((item) => item.dataset['conversationKind'] === 'room');
    expect(row?.textContent).toContain('发布房间');
    await act(async () => { row?.click(); });
    expect(navigate).toHaveBeenCalledWith('/rooms/room_alpha');
  });

  it('shows search only once the list is long, and filters title and workspace', async () => {
    const many = Array.from({ length: 9 }, (_, index) => session({ id: `topic_${index}`, title: `话题 ${index}` }));
    const rendered = await render({ sessions: many });
    const search = rendered.container.querySelector<HTMLInputElement>('input');
    expect(search).not.toBeNull();
    await type(search!, '话题 3');
    const visible = menuItems(rendered.container).map((item) => item.dataset['conversationItem']);
    // The daily row is the persona's home ("home_lin"), and it is an entrance
    // rather than a search result.
    expect(visible).toEqual(['home_lin', 'topic_3']);

    const short = await render({ sessions: many.slice(0, 3) });
    expect(short.container.querySelector('input')).toBeNull();
  });

  it('walks with ↑↓, closes on Esc and hands focus back to whatever opened it', async () => {
    const rendered = await render({ sessions: [session({ id: 'home_lin' }), session({ id: 'topic_1' }), session({ id: 'topic_2' })] });
    const items = menuItems(rendered.container);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      rendered.container.querySelector('[role="menu"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => {
      rendered.container.querySelector('[role="menu"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(rendered.onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(rendered.anchor);
  });

  it('starts a new conversation in the current project and leaves the daily pointer alone', async () => {
    const rendered = await render({
      sessions: [session({ id: 'home_lin' }), session({ id: 'topic_1', workspace_id: 'ws_a' })],
      activeSessionId: 'topic_1',
    });
    await act(async () => {
      rendered.container.querySelector<HTMLElement>('[data-persona-switcher-new]')!.click();
    });
    expect(navigate).toHaveBeenCalledWith('/new?persona=lin-lan&workspace=ws_a');
    await act(async () => {
      rendered.container.querySelector<HTMLElement>('[data-persona-switcher-all]')!.click();
    });
    expect(navigate).toHaveBeenCalledWith('/personas?persona=lin-lan&view=conversations');
  });

  it('keeps the current conversation visible when the list is cut at eight', async () => {
    const many = Array.from({ length: 12 }, (_, index) => session({ id: `topic_${index}`, title: `话题 ${index}`, updated_at: `2026-10-0${index % 9 + 1}T00:00:00Z` }));
    const rendered = await render({ sessions: many, activeSessionId: 'topic_0' });
    expect(rendered.container.querySelector('[data-conversation-item="topic_0"]')).not.toBeNull();
    expect(menuItems(rendered.container)).toHaveLength(9);
  });

  it('says the list is being read, or that it failed, rather than that there are none', async () => {
    // The daily row is an entrance, not a result, so with no other
    // conversation the panel would otherwise show only "start the first
    // daily conversation" — which reads as "this persona has nothing", while
    // the answer is that the read has not come back yet.
    const quiet = (container: HTMLElement) => container.textContent ?? '';
    const fresh = persona({ homeSessionId: undefined });

    const settled = await render({ persona: fresh, sessions: [] });
    expect(quiet(settled.container)).toContain('没有匹配的对话');

    const loading = await render({ persona: fresh, sessions: [], status: { loading: true } });
    expect(quiet(loading.container)).toContain('正在读取对话');
    expect(quiet(loading.container)).not.toContain('没有匹配的对话');

    const failed = await render({ persona: fresh, sessions: [], status: { error: 'Session index is building' } });
    expect(quiet(failed.container)).toContain('对话列表读取失败');
    expect(quiet(failed.container)).toContain('Session index is building');
    expect(quiet(failed.container)).not.toContain('没有匹配的对话');
  });

  it('stays out of the way once there are conversations to pick from', async () => {
    const rendered = await render({
      sessions: [session({ id: 'topic_1' })],
      status: { loading: true },
    });
    expect(rendered.container.textContent).not.toContain('正在读取对话');
    expect(rendered.container.textContent).not.toContain('没有匹配的对话');
  });
});
