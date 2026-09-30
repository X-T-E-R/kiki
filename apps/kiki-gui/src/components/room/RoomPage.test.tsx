// @vitest-environment jsdom

/**
 * Room page against a stubbed klient `rest` facade: the placeholder states
 * the routing rule, @ completes members with 「所有人」 first, a send (an
 * interjection while members run) posts through `postUserMessage`, the live
 * pause line continues the room, a roster change refused mid-turn asks to
 * stop first, and the question queue is counted.
 */

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSummary, RoomDocument, RoomLogEntry, RoomUsage } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { mentionAtCaret, mentionOptions } from './roomLog';
import { RoomPage } from './RoomPage';

const rooms = vi.hoisted(() => ({
  get: vi.fn(),
  log: vi.fn(),
  usage: vi.fn(),
  update: vi.fn(),
  postUserMessage: vi.fn(),
  pause: vi.fn(),
  continue: vi.fn(),
  stop: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(async () => []),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  searchThreads: vi.fn(),
}));
const client = vi.hoisted(() => ({
  klient: { rest: { rooms, bots: { list: async () => [] } } },
  listPersonas: vi.fn(),
  getSession: vi.fn(),
  listPendingQuestions: vi.fn(async () => []),
  getPersonaAvatar: vi.fn(async () => null),
  getConfig: vi.fn(async () => ({ thread_communication: { enabled: true } })),
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
  useOptionalConnection: () => ({ client }),
}));

const PERSONAS: PersonaSummary[] = [
  { id: 'lin-lan', name: '林岚', title: '发布协调', revision: 'r1', archived: false },
  { id: 'a-che', name: '阿澈', title: '写作', revision: 'r1', archived: false },
  { id: 'xiao-lan', name: '小蓝', title: '调研', revision: 'r1', archived: false },
];

function roomDoc(overrides: Partial<RoomDocument> = {}): RoomDocument {
  return {
    version: 1, id: 'release-031', name: '0.31 发布',
    members: [
      { kind: 'persona', personaId: 'lin-lan', sessionId: 'sess_lin', muted: false },
      { kind: 'persona', personaId: 'a-che', sessionId: 'sess_che', muted: false },
      { kind: 'persona', personaId: 'xiao-lan', sessionId: 'sess_lan', muted: false },
    ],
    host: 'lin-lan', mode: 'mention', budget: { botMessagesPerUserMessage: 12 },
    workspace: 'C:/work/kiki', createdAt: '2026-10-01T08:00:00.000Z', generation: 0,
    paused: false, budgetUsed: 0, userMessageCount: 1, cursors: {},
    ...overrides,
  } as RoomDocument;
}

function usage(overrides: Partial<RoomUsage> = {}): RoomUsage {
  return { userMessages: 1, botMessages: 0, budgetUsed: 0, budgetLimit: 12, paused: false, members: [], ...overrides };
}

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'idem-1' });
});

afterAll(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  for (const fn of Object.values(rooms)) fn.mockReset();
  rooms.list.mockResolvedValue([]);
  rooms.get.mockResolvedValue(roomDoc());
  rooms.log.mockResolvedValue({ entries: [] });
  rooms.usage.mockResolvedValue(usage());
  client.listPersonas.mockResolvedValue(PERSONAS);
  client.getSession.mockImplementation(async (id: string) => ({ id, busy: false, metadata: { cwd: 'C:/' } }));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function renderRoom(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/rooms/release-031']}>
            <I18nProvider>
              <Routes>
                <Route path="/rooms/:id" element={<RoomPage sessions={[]} onToggleSidebar={() => {}} />} />
              </Routes>
            </I18nProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  });
  await flush();
  return container;
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(target: HTMLElement, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

describe('room mention helpers', () => {
  it('finds the @word under the caret and lists 所有人 first', () => {
    expect(mentionAtCaret('你好 @阿', 5)).toEqual({ start: 3, query: '阿' });
    expect(mentionAtCaret('mail@x', 6)).toBeUndefined();
    const members = [{ personaId: 'a-che', name: '阿澈' }, { personaId: 'xiao-lan', name: '小蓝' }];
    expect(mentionOptions(members, '', { label: '所有人', hint: '' }).map((option) => option.key)).toEqual(['*', 'a-che', 'xiao-lan']);
    expect(mentionOptions(members, '阿', { label: '所有人', hint: '' }).map((option) => option.key)).toEqual(['a-che']);
  });
});

describe('RoomPage', () => {
  it('states the routing rule in the placeholder and completes @ with 所有人 first (acceptance 5)', async () => {
    const container = await renderRoom();
    const input = container.querySelector<HTMLTextAreaElement>('[data-room-input]')!;
    expect(input.placeholder).toContain('发到 0.31 发布');
    expect(input.placeholder).toContain('不 @ 交给 林岚');
    await act(async () => { type(input, '@'); });
    const options = [...container.querySelectorAll('[data-room-mention]')].map((node) => node.getAttribute('data-room-mention'));
    expect(options).toEqual(['*', 'lin-lan', 'a-che', 'xiao-lan']);
    await act(async () => { key(input, 'ArrowDown'); key(input, 'ArrowDown'); });
    await act(async () => { key(input, 'Enter'); });
    expect(input.value).toBe('@阿澈 ');
  });

  it('interjects through postUserMessage with an idempotency key while members run (acceptance 6)', async () => {
    client.getSession.mockImplementation(async (id: string) => ({ id, busy: id === 'sess_che', metadata: { cwd: 'C:/' } }));
    rooms.postUserMessage.mockResolvedValue({ id: 'm9', at: '2026-10-01T09:00:00.000Z', kind: 'message', from: 'user', text: '先停一下', mentions: [] });
    const container = await renderRoom();
    expect(container.querySelector('[data-message-presence]')?.textContent).toContain('阿澈 正在处理');
    const input = container.querySelector<HTMLTextAreaElement>('[data-room-input]')!;
    await act(async () => { type(input, '先停一下，改成周五发'); });
    await act(async () => { key(input, 'Enter'); });
    await flush();
    expect(rooms.postUserMessage).toHaveBeenCalledWith('release-031', { text: '先停一下，改成周五发', idempotencyKey: 'idem-1' });
    expect(input.value).toBe('');
  });

  it('continues a budget-paused room from the live system line (acceptance 5)', async () => {
    rooms.get.mockResolvedValue(roomDoc({ paused: true, pauseReason: 'budget', budgetUsed: 12 }));
    const entries: RoomLogEntry[] = [
      { id: 'm1', at: '2026-10-01T09:00:00.000Z', kind: 'message', from: 'user', text: '这周能发吗', mentions: [] },
      { id: 'm2', at: '2026-10-01T09:00:10.000Z', kind: 'message', from: 'lin-lan', text: '能，差两件事。', mentions: [] },
      { id: 's1', at: '2026-10-01T09:05:00.000Z', kind: 'system', from: 'system', event: 'budget_exhausted', text: '', data: { budget: 12 } },
    ];
    rooms.log.mockResolvedValue({ entries });
    rooms.continue.mockResolvedValue(roomDoc());
    const container = await renderRoom();
    const line = container.querySelector('[data-room-system="budget_exhausted"]');
    expect(line?.textContent).toContain('讨论已暂停（本轮 12 条已用完）');
    expect(line?.getAttribute('data-room-system-live')).toBe('true');
    await act(async () => { line?.querySelector<HTMLButtonElement>('[data-room-system-continue]')?.click(); });
    await flush();
    expect(rooms.continue).toHaveBeenCalledWith('release-031');
  });

  it('asks to stop first when a roster change is refused mid-turn, and stops from there', async () => {
    rooms.update.mockRejectedValue(new Error('Stop the active room turn before changing its members or workspace.'));
    rooms.stop.mockResolvedValue(roomDoc());
    const container = await renderRoom();
    if (container.querySelector('[data-room-members]') === null) {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-roster]')?.click(); });
    }
    const remove = container.querySelector<HTMLButtonElement>('[data-room-member="a-che"] [data-room-remove-member]')!;
    await act(async () => { remove.click(); });
    await flush();
    const banner = container.querySelector('[data-room-roster-locked]');
    expect(banner?.textContent).toContain('先停止再改成员或工作区');
    await act(async () => { banner?.querySelector<HTMLButtonElement>('[data-room-stop-inline]')?.click(); });
    await flush();
    expect(rooms.stop).toHaveBeenCalledWith('release-031');
  });

  it('keeps host and mute editable and locks the roster while a member holds a question', async () => {
    rooms.usage.mockResolvedValue(usage({ questions: { activeSessionId: 'sess_lan', queued: 2 } }));
    rooms.update.mockResolvedValue(roomDoc({ host: 'a-che' }));
    client.listPendingQuestions.mockResolvedValue([{
      question_id: 'q1', session_id: 'sess_lan', created_at: '2026-10-01T09:00:00.000Z',
      questions: [{ id: 'i1', question: '证书续期走哪个供应商？', options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }] }],
    }] as never);
    const container = await renderRoom();
    if (container.querySelector('[data-room-members]') === null) {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-roster]')?.click(); });
    }
    expect(container.querySelector('[data-room-questions-queued]')?.textContent).toBe('还有 2 个问题');
    expect(container.textContent).toContain('证书续期走哪个供应商？');
    expect(container.querySelector('[data-room-roster-locked]')?.textContent).toContain('暂不能增减成员');
    expect(container.querySelector<HTMLButtonElement>('[data-room-member="a-che"] [data-room-remove-member]')?.disabled).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-member="a-che"] [data-room-set-host]')?.click(); });
    await flush();
    expect(rooms.update).toHaveBeenCalledWith('release-031', { host: 'a-che' });
  });

  it('shows thread members by title, says a busy one replies after its turn, and leaves without touching the thread', async () => {
    const threadRoom = roomDoc({
      id: 'release-031', host: 'sess_backend',
      members: [
        { kind: 'thread', sessionId: 'sess_backend', muted: false, joinedAt: '2026-10-01T08:00:00.000Z', queueWhenBusy: true },
        { kind: 'thread', sessionId: 'sess_frontend', muted: false, joinedAt: '2026-10-01T08:00:00.000Z', queueWhenBusy: true },
        { kind: 'thread', sessionId: 'sess_tests', muted: false, joinedAt: '2026-10-01T08:00:00.000Z', queueWhenBusy: false },
      ],
    });
    rooms.get.mockResolvedValue(threadRoom);
    rooms.log.mockResolvedValue({ entries: [
      { id: 's1', at: '2026-10-01T09:00:00.000Z', kind: 'system', from: 'system', event: 'member_joined', text: '', data: { memberId: 'sess_backend' } },
      { id: 'm1', at: '2026-10-01T09:01:00.000Z', kind: 'message', from: 'sess_frontend', text: '字段名对一下', mentions: ['sess_backend'] },
    ] });
    rooms.removeMember.mockResolvedValue(roomDoc({ ...threadRoom, members: threadRoom.members.slice(0, 2) }));
    rooms.update.mockResolvedValue(threadRoom);
    const titles: Record<string, string> = { sess_backend: '后端线程', sess_frontend: '前端线程', sess_tests: '测试线程' };
    client.getSession.mockImplementation(async (id: string) => ({ id, title: titles[id] ?? '', busy: id === 'sess_backend', metadata: { cwd: 'C:/' }, agent_config: { model: 'm' } }));
    const container = await renderRoom();
    if (container.querySelector('[data-room-members]') === null) {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-roster]')?.click(); });
    }
    await flush();
    expect(container.querySelector('[data-room-system="member_joined"]')?.textContent).toBe('后端线程 加入了房间');
    expect(container.querySelector('[data-room-message="m1"]')?.textContent).toContain('前端线程');
    expect(container.querySelector('[data-room-queued]')?.textContent).toBe('后端线程 正忙，结束后回复');
    expect(container.querySelector('[data-room-member="sess_backend"] [data-room-member-status]')?.textContent).toBe('正忙，结束后回复');
    expect(container.querySelector('[data-room-input]')?.getAttribute('placeholder')).toContain('@ 谁就唤醒谁');
    const toggle = container.querySelector<HTMLInputElement>('[data-room-member="sess_tests"] input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    await flush();
    expect(rooms.update).toHaveBeenCalledWith('release-031', { members: expect.arrayContaining([
      { kind: 'thread', sessionId: 'sess_tests', muted: false, queueWhenBusy: true },
    ]) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-room-member="sess_tests"] [data-room-leave]')?.click(); });
    await flush();
    expect(rooms.removeMember).toHaveBeenCalledWith('release-031', 'sess_tests');
  });
});
