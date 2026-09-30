// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomChangeEvent, RoomListItem, Session } from '@kiki/protocol';
import { markRoomSeen, resetSessionSeen, sessionSeenSnapshot } from '@kiki/session-core/settings';
import { useConversationList } from './useConversationList';
import { RoomLinkRedirect } from './conversationRoutes';

const mock = vi.hoisted(() => ({ listItems: vi.fn(), on: vi.fn(), dispose: vi.fn() }));
const client = { klient: { rest: { rooms: { listItems: mock.listItems } }, events: { on: mock.on } } };
vi.mock('../state/connection', () => ({ useConnection: () => ({ client }) }));
const roots: Root[] = [];
let changed: ((event: RoomChangeEvent) => void) | undefined;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  changed = undefined;
  mock.listItems.mockReset();
  mock.on.mockImplementation((_name: string, callback: (event: RoomChangeEvent) => void) => {
    changed = callback;
    return { dispose: mock.dispose };
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
  resetSessionSeen();
});
const room: RoomListItem = { kind: 'room', id: 'example', title: 'Room', workspace: 'room-workspace', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z', lastSeq: 2, memberCount: 2, busy: false, needsYou: false, pendingInteraction: 'none', failed: false, pinned: false, archived: false };
const sessions = [{ id: 'session_example', title: 'Thread', metadata: { cwd: '/example' }, workspace_id: 'thread-workspace', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', busy: false, last_seq: 1 }] as Session[];
function List() {
  const { items, roomsQuery } = useConversationList(sessions);
  return <div data-error={roomsQuery.isError}>{items.map((item) => <span key={item.key}>{item.key}:{item.unread_count};</span>)}</div>;
}
async function mount(content: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{content}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return container;
}

describe('conversation source', () => {
  it('returns rooms mixed with threads and responds to the shared read store and deletion event', async () => {
    mock.listItems.mockResolvedValue([room]);
    const container = await mount(<List />);
    expect(container.textContent).toBe('room:example:2;session:session_example:1;');
    expect(mock.on).toHaveBeenCalledWith('room.changed', expect.any(Function));
    await act(async () => { markRoomSeen(room.id, room.lastSeq); });
    expect(container.textContent).toBe('room:example:0;session:session_example:1;');
    mock.listItems.mockResolvedValue([]);
    await act(async () => {
      changed?.({ roomId: room.id, room: {} as RoomChangeEvent['room'], deleted: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.textContent).toBe('session:session_example:1;');
    expect(sessionSeenSnapshot()['room:example']).toBeUndefined();
    expect(mock.listItems).toHaveBeenCalledTimes(2);
  });
  it('exposes a failed room query rather than hiding it as a successful empty list', async () => {
    mock.listItems.mockRejectedValue(new Error('Rooms unavailable'));
    const container = await mount(<List />);
    expect(container.querySelector('[data-error]')?.getAttribute('data-error')).toBe('true');
    expect(container.textContent).toBe('session:session_example:1;');
  });
});

function Location() {
  const location = useLocation();
  return <div>{location.pathname}{location.search}{location.hash}</div>;
}
describe('room link routing', () => {
  it.each([['/r/example?workspace=ws#message', '/rooms/example?workspace=ws#message'], ['/r/a%2Fb', '/new']])('routes %s to %s', async (input, expected) => {
    const container = await mount(<MemoryRouter initialEntries={[input]}><Routes><Route path="/r/:id" element={<RoomLinkRedirect />} /><Route path="/rooms/:id" element={<Location />} /><Route path="/new" element={<Location />} /></Routes></MemoryRouter>);
    expect(container.textContent).toBe(expected);
  });
});
