// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@kiki/protocol';
import { resetSessionSeen, sessionSeenSnapshot } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '@kiki/session-core/storage';
import type { StableCompletion } from '@kiki/session-core/sessions';
import type { HostAdapter } from '../host';
import { awayNotifier } from './awayNotify';
import { useAwayNotifications, useViewedSession } from './useAwayNotifications';

const connection = vi.hoisted(() => ({
  spaceKey: 'home-example', scopeId: 'local', meta: { server_home_id: 'server-example' },
  client: { notifications: { listCompletions: vi.fn() } },
}));
vi.mock('../state/connection', () => ({ useConnection: () => connection }));
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key, tp: (key: string) => key }) }));
vi.mock('./threadTitles', () => ({ useThreadTitleResolver: () => (title: string) => title }));

const sessions = ['a', 'b'].map((id) => ({ id, title: id, last_seq: 10, busy: false,
  pending_interaction: 'none', last_turn_reason: 'completed', message_count: 2,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', workspace_id: 'example' })) as Session[];

let root: Root;
let container: HTMLDivElement;
let completions: readonly StableCompletion[];
let focused: boolean;
let visible: boolean;
let navigate: ReturnType<typeof useNavigate>;
let replaceSessions: (rows: Session[]) => void;
const notify = vi.fn(async (_notification: import('../host').HostNotification) => {});
const badge = vi.fn(async (_count: number, _homeId?: string, _scopeId?: string, _sessionIds?: readonly string[]) => {});
const acknowledge = vi.fn(async (_sessionId: string, _scope: unknown, _deliveryId?: string) => {});
const host = { kind: 'browser', notify, setUnreadBadge: badge, acknowledgeNotifications: acknowledge,
  isWindowVisibleAndFocused: async () => focused } as unknown as HostAdapter;

function Viewed() {
  const location = useLocation();
  const id = /^\/s\/([^/]+)/u.exec(location.pathname)?.[1] ?? '';
  useViewedSession(host, id, id === '' ? undefined : 10);
  return <div data-session={id}>{id || 'Home'}</div>;
}
function Surface() {
  const [rows, setRows] = useState(sessions);
  replaceSessions = setRows;
  navigate = useNavigate();
  useAwayNotifications({ host, sessions: rows, listSessions: async () => rows, navigate: (target) => { void navigate(target); } });
  return <Viewed />;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  completions = []; focused = true; visible = true;
  localStorage.clear(); configureSpaceStorage({ homeId: 'home-example' }); resetSessionSeen();
  awayNotifier.reset(); notify.mockReset(); badge.mockClear(); acknowledge.mockReset();
  connection.client.notifications.listCompletions.mockImplementation(async () => completions);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  awayNotifier.reset(); configureSpaceStorage(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mount(route = '/s/a') {
  await act(async () => { root.render(<MemoryRouter initialEntries={[route]}><Surface /></MemoryRouter>); });
  await flush();
}

describe('conversation completion and read confirmation', () => {
  it('keeps B notified/unread through App focus, home and A; only opening B acknowledges B', async () => {
    await mount();
    expect(sessionSeenSnapshot()).toEqual({ a: 10 });
    completions = [{ session_id: 'b', episode_id: 'episode-b', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ route: '/s/b', homeId: 'home-example', scopeId: 'local' });
    expect(badge).toHaveBeenLastCalledWith(1, 'home-example', 'local', ['b']);
    await act(async () => { window.dispatchEvent(new Event('focus')); await navigate('/'); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await navigate('/s/a'); });
    expect(sessionSeenSnapshot()).toEqual({ a: 10 });
    expect(badge.mock.calls.at(-1)?.[0]).toBe(1);
    await act(async () => { await navigate('/s/b'); }); await flush();
    expect(container.querySelector<HTMLElement>('[data-session]')?.dataset['session']).toBe('b');
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 10 });
    expect(badge.mock.calls.at(-1)?.[0]).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('acknowledges only the viewed conversation in its full scope, including child routes', async () => {
    await mount('/settings');
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => { await navigate('/s/b/agent/child-example'); });
    expect(sessionSeenSnapshot()).toEqual({ b: 10 });
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith('b', {
      homeId: 'home-example', scopeId: 'local', serverHomeId: 'server-example', connectionRef: undefined,
    });
    focused = false;
    await act(async () => { await navigate('/s/a'); window.dispatchEvent(new Event('focus')); });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a notification that finishes sending after its conversation was opened', async () => {
    let finishSending!: () => void;
    notify.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSending = resolve; }));
    await mount('/s/a');
    completions = [{ session_id: 'b', episode_id: 'late-send-b', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);
    await act(async () => { await navigate('/s/b'); });
    expect(acknowledge.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1);
    await act(async () => { finishSending(); });
    expect(acknowledge.mock.calls.filter(([id]) => id === 'b')).toHaveLength(2);
  });

  it('N052-F2: reconciles a pending delivery read before leaving, without acknowledging another episode or scope', async () => {
    type Entry = import('../host').HostNotification;
    const retained = new Map<string, Entry>();
    let finishSending!: () => void;
    notify.mockImplementationOnce(async (notification) => {
      await new Promise<void>((resolve) => { finishSending = resolve; });
      retained.set(notification.deliveryId!, notification);
    });
    acknowledge.mockImplementation(async (id, scope, deliveryId) => {
      for (const [key, entry] of retained) {
        if (JSON.stringify(entry.scope) !== JSON.stringify(scope) || (deliveryId !== undefined && key !== deliveryId)) continue;
        if (entry.sessionIds?.includes(id)) retained.delete(key);
      }
    });
    await mount('/s/a');
    completions = [{ session_id: 'b', episode_id: 'pending-b', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const sending = notify.mock.calls[0]![0];
    await act(async () => { await navigate('/s/b'); });
    expect(sessionSeenSnapshot()).toMatchObject({ b: 10 });
    await act(async () => { await navigate('/s/a'); });
    retained.set('new-episode-b', { ...sending, deliveryId: 'new-episode-b' });
    retained.set('unread-c', { ...sending, sessionIds: ['c'], deliveryId: 'unread-c' });
    retained.set('other-scope-b', { ...sending, scope: { ...sending.scope!, scopeId: 'ssh:example' }, deliveryId: 'other-scope-b' });
    await act(async () => { finishSending(); });
    expect([...retained.keys()]).toEqual(['new-episode-b', 'unread-c', 'other-scope-b']);
    expect(acknowledge.mock.calls.filter(([id]) => id === 'b')).toEqual([
      ['b', sending.scope], ['b', sending.scope, sending.deliveryId],
    ]);
  });

  it('does not mark an open background conversation read; focus confirms its latest sequence', async () => {
    focused = false; visible = false;
    await mount('/s/b');
    expect(sessionSeenSnapshot()).toEqual({});
    focused = true; visible = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    expect(sessionSeenSnapshot()).toEqual({ b: 10 });
  });

  it('does not confirm a conversation hidden while its host focus probe is pending', async () => {
    let resolve: ((value: boolean) => void) | undefined;
    vi.spyOn(host, 'isWindowVisibleAndFocused').mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    await mount('/s/b');
    visible = false;
    await act(async () => { resolve?.(true); });
    expect(sessionSeenSnapshot()).toEqual({});
  });

  it('reopens with the saved cursor: no duplicate and no swallowed completion during a poll failure', async () => {
    await mount();
    connection.client.notifications.listCompletions.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    completions = [{ session_id: 'b', episode_id: 'during-disconnect', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount();
    expect(notify).toHaveBeenCalledTimes(1);
    completions = [{ session_id: 'b', episode_id: 'after-reopen', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the native badge unchanged through bulk metadata refreshes, but publishes changed membership', async () => {
    await mount();
    badge.mockClear();
    const refresh = async (revision: number) => {
      await act(async () => { replaceSessions(sessions.map((session) => ({ ...session, title: `${session.id}-${revision}` }))); });
    };
    for (let revision = 0; revision < 20; revision++) await refresh(revision);
    expect(badge).not.toHaveBeenCalled();
    await act(async () => { replaceSessions(sessions.map((session) => session.id === 'b' ? { ...session, id: 'c' } : session)); });
    expect(badge).toHaveBeenCalledExactlyOnceWith(1, 'home-example', 'local', ['c']);
    await act(async () => { replaceSessions(sessions.filter((session) => session.id === 'a')); });
    expect(badge).toHaveBeenLastCalledWith(0, 'home-example', 'local', []);
  });

  it('suppresses the visible conversation completion on a child route, without suppressing other sessions', async () => {
    await mount('/s/a/agent/child-example');
    completions = ['a', 'b'].map((session_id) => ({ session_id, episode_id: `finished-${session_id}`, completed_at: Date.now() }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ route: '/s/b' }));
  });
});
