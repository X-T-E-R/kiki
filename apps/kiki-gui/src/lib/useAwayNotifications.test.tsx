// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@kiki/protocol';
import { markSessionsSeen, resetSessionSeen, sessionSeenSnapshot } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '@kiki/session-core/storage';
import {
  buildInboxModel,
  mergeSessionActivity,
  mergeSessionFirstPage,
  sessionRowState,
  type SessionListData,
  type StableCompletion,
} from '@kiki/session-core/sessions';
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

function Viewed({ sessions }: { readonly sessions: readonly Session[] }) {
  const location = useLocation();
  const id = /^\/s\/([^/]+)/u.exec(location.pathname)?.[1] ?? '';
  const current = sessions.find((session) => session.id === id);
  useViewedSession(host, id, id === '' ? undefined : (current?.last_seq ?? 10));
  return <div data-session={id}>{id || 'Home'}</div>;
}
function Surface() {
  const [rows, setRows] = useState(sessions);
  replaceSessions = setRows;
  navigate = useNavigate();
  useAwayNotifications({ host, sessions: rows, listSessions: async () => rows, navigate: (target) => { void navigate(target); } });
  return <Viewed sessions={rows} />;
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

  it('retains B hollow unread mark, Activity inbox and badge across list refreshes and late point reads while A stays open, clears only B on open, and re-flags B on a later completion', async () => {
    const c = { ...sessions[1]!, id: 'c', title: 'c', last_seq: 10 };
    let listData: SessionListData = {
      pages: [{ items: [sessions[0]!, sessions[1]!, c], has_more: false }],
      pageParams: [undefined],
    };
    await mount('/s/a');
    await act(async () => { replaceSessions(listData.pages[0]!.items); });
    await act(async () => { await navigate('/s/b'); });
    await flush();
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 10 });
    await act(async () => { await navigate('/s/a'); });
    await flush();

    // B finishes a new episode: point read from metaUpdated arrives with last_seq: 14, then
    // a periodic list poll or late point read arrives with an older/zero last_seq.
    const completedB: Session = {
      ...sessions[1]!,
      last_seq: 14,
      updated_at: '2026-10-07T00:00:05Z',
      last_turn_reason: 'completed',
    };
    listData = mergeSessionActivity(listData, completedB)!;
    await act(async () => { replaceSessions(listData.pages[0]!.items); });
    completions = [{ session_id: 'b', episode_id: 'episode-b-1', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(badge).toHaveBeenLastCalledWith(2, 'home-example', 'local', ['b', 'c']);

    // Simulate the periodic first-page list refresh returning last_seq: 0 (or a stale lower watermark)
    // and a late point read with a newer metadata timestamp but stale watermark.
    listData = mergeSessionFirstPage(listData, {
      items: [
        { ...sessions[0]!, last_seq: 0 },
        { ...completedB, last_seq: 0, updated_at: '2026-10-07T00:00:15Z' },
        { ...c, last_seq: 0 },
      ],
      has_more: false,
    })!;
    listData = mergeSessionActivity(listData, {
      ...completedB,
      title: 'b-renamed',
      last_seq: 0,
      updated_at: '2026-10-07T00:00:20Z',
    })!;
    await act(async () => { replaceSessions(listData.pages[0]!.items); });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigate('/');
      await navigate('/s/a');
      await vi.advanceTimersByTimeAsync(15000);
    });

    const currentRows = listData.pages[0]!.items;
    const rowB = currentRows.find((row) => row.id === 'b')!;
    const rowC = currentRows.find((row) => row.id === 'c')!;
    expect(sessionRowState(rowB, sessionSeenSnapshot())).toBe('unread');
    expect(sessionRowState(rowC, sessionSeenSnapshot())).toBe('unread');
    expect(buildInboxModel(currentRows, sessionSeenSnapshot()).unread.map((item) => item.sessionId)).toEqual(['b', 'c']);
    expect(badge).toHaveBeenLastCalledWith(2, 'home-example', 'local', ['b', 'c']);
    expect(notify).toHaveBeenCalledTimes(1);

    // Opening B acknowledges only B (leaving C unread) and does not re-send the notification.
    await act(async () => { await navigate('/s/b'); });
    await flush();
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 14 });
    expect(sessionRowState(rowB, sessionSeenSnapshot())).toBe('read');
    expect(sessionRowState(rowC, sessionSeenSnapshot())).toBe('unread');
    expect(buildInboxModel(currentRows, sessionSeenSnapshot()).unread.map((item) => item.sessionId)).toEqual(['c']);
    expect(badge).toHaveBeenLastCalledWith(1, 'home-example', 'local', ['c']);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notify).toHaveBeenCalledTimes(1);

    // Return to A; B completes a second episode and becomes unread + notified again.
    await act(async () => { await navigate('/s/a'); });
    await flush();
    const secondB: Session = {
      ...rowB,
      last_seq: 18,
      updated_at: '2026-10-07T00:01:00Z',
      last_turn_reason: 'completed',
    };
    listData = mergeSessionActivity(listData, secondB)!;
    await act(async () => { replaceSessions(listData.pages[0]!.items); });
    completions = [{ session_id: 'b', episode_id: 'episode-b-2', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const rowsAfterSecond = listData.pages[0]!.items;
    expect(sessionRowState(rowsAfterSecond.find((row) => row.id === 'b')!, sessionSeenSnapshot())).toBe('unread');
    expect(buildInboxModel(rowsAfterSecond, sessionSeenSnapshot()).unread.map((item) => item.sessionId)).toEqual(['b', 'c']);
    expect(badge).toHaveBeenLastCalledWith(2, 'home-example', 'local', ['b', 'c']);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not bounce B back to unread when its completion receipt arrives after opening B or Mark all as read', async () => {
    await mount('/s/a');
    const finishedB: Session = {
      ...sessions[1]!,
      last_seq: 14,
      updated_at: '2026-10-07T00:00:05Z',
      last_turn_reason: 'completed',
    };
    const currentRows = [sessions[0]!, finishedB];
    await act(async () => { replaceSessions(currentRows); });

    // User opens and focuses B before the 5s completion poll observes the episode, then switches back to A.
    await act(async () => { await navigate('/s/b'); });
    await flush();
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 14 });
    await act(async () => { await navigate('/s/a'); });
    await flush();

    // The completion receipt for that same episode arrives on the next poll tick.
    completions = [{ session_id: 'b', episode_id: 'late-episode-b-1', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 14 });
    expect(sessionRowState(finishedB, sessionSeenSnapshot())).toBe('read');
    expect(buildInboxModel(currentRows, sessionSeenSnapshot()).unread).toEqual([]);
    expect(badge).toHaveBeenLastCalledWith(0, 'home-example', 'local', []);

    // Next episode: B finishes at seq 18, user clicks "Mark all as read" before the completion poll arrives.
    const nextFinishedB: Session = {
      ...finishedB,
      last_seq: 18,
      updated_at: '2026-10-07T00:01:00Z',
    };
    const nextRows = [sessions[0]!, nextFinishedB];
    await act(async () => {
      replaceSessions(nextRows);
      markSessionsSeen([{ sessionId: 'b', lastSeq: 18 }]);
    });
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 18 });

    completions = [{ session_id: 'b', episode_id: 'late-episode-b-2', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(sessionSeenSnapshot()).toEqual({ a: 10, b: 18 });
    expect(sessionRowState(nextFinishedB, sessionSeenSnapshot())).toBe('read');
    expect(buildInboxModel(nextRows, sessionSeenSnapshot()).unread).toEqual([]);
    expect(badge).toHaveBeenLastCalledWith(0, 'home-example', 'local', []);
  });

  it('keeps read sessions read across cross-window late storage writes and >300 viewed sessions while still flagging a new episode unread', async () => {
    const manySessions: Session[] = Array.from({ length: 305 }, (_, index) => ({
      ...sessions[0]!,
      id: `s-${index + 1}`,
      title: `Session ${index + 1}`,
      last_seq: 10,
      updated_at: '2026-10-07T00:00:00Z',
    }));
    await mount('/s/s-1');
    await act(async () => { replaceSessions(manySessions); });
    await flush();
    expect(sessionSeenSnapshot()['s-1']).toBe(10);

    // Another window marks s-2 read in localStorage before its storage event arrives,
    // while this window switches across 303 more sessions (>300 total).
    localStorage.setItem(
      'kiki.space.home-example.kiki.sessionSeen.v1',
      JSON.stringify({ 's-1': 10, 's-2': 10 }),
    );
    for (let i = 3; i <= 305; i += 1) {
      await act(async () => { await navigate(`/s/s-${i}`); });
    }
    await flush();

    const seen = sessionSeenSnapshot();
    expect(seen['s-1']).toBe(10);
    expect(seen['s-2']).toBe(10);
    expect(seen['s-305']).toBe(10);
    expect(sessionRowState(manySessions[0]!, seen)).toBe('read');
    expect(sessionRowState(manySessions[1]!, seen)).toBe('read');
    expect(buildInboxModel(manySessions, seen).unread).toEqual([]);
    expect(badge).toHaveBeenLastCalledWith(0, 'home-example', 'local', []);

    // A genuine new episode on s-1 advances last_seq and marks only s-1 unread.
    const updatedMany = manySessions.map((row) =>
      row.id === 's-1'
        ? { ...row, last_seq: 15, updated_at: '2026-10-07T00:02:00Z', last_turn_reason: 'completed' as const }
        : row,
    );
    await act(async () => { replaceSessions(updatedMany); });
    completions = [{ session_id: 's-1', episode_id: 'episode-s-1-new', completed_at: Date.now() }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(sessionRowState(updatedMany[0]!, sessionSeenSnapshot())).toBe('unread');
    expect(sessionRowState(updatedMany[1]!, sessionSeenSnapshot())).toBe('read');
    expect(buildInboxModel(updatedMany, sessionSeenSnapshot()).unread.map((item) => item.sessionId)).toEqual(['s-1']);
    expect(badge).toHaveBeenLastCalledWith(1, 'home-example', 'local', ['s-1']);
  });
});
