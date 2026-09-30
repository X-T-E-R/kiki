import { afterEach, describe, expect, it } from 'vitest';
import type { RoomListItem, Session, Workspace } from '@kiki/protocol';
import { buildConversationInbox, groupConversationItems, mergeConversationItems, roomWorkspaceId } from './conversationList';
import { parseConversationLink, roomRefLink } from './conversationLinks';
import { forgetRoomSeen, markRoomSeen, markSessionSeen, resetSessionSeen, roomUnreadCount, sessionSeenSnapshot } from '../settings';

function room(patch: Partial<RoomListItem> = {}): RoomListItem {
  return { kind: 'room', id: 'example', title: 'Room', workspace: 'ws-room', createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date(2026, 0, 3, 12).toISOString(), lastSeq: 3, memberCount: 2, busy: false, needsYou: false, pendingInteraction: 'none', failed: false, pinned: false, archived: false, ...patch };
}
function session(patch: Partial<Session> = {}): Session {
  return { id: 'example', title: 'Thread', workspace_id: 'ws-thread', created_at: '2026-01-01T00:00:00Z', updated_at: new Date(2026, 0, 3, 10).toISOString(), metadata: { cwd: '/example' }, busy: false, last_seq: 10, ...patch } as Session;
}
const workspaces = [{ id: 'ws-thread', name: 'Threads', root: '/example' }, { id: 'ws-room', name: 'Rooms', root: '/rooms' }] as Workspace[];
const filters = { archived: 'hide' as const, status: [], workspaces: [] };
afterEach(() => resetSessionSeen());

describe('conversation list and read state', () => {
  it('resolves the room own root for projections, grouping, filtering and inbox without borrowing a thread workspace', () => {
    const rooms = [room({ workspace: '/rooms' }), room({ id: 'unknown', workspace: '/unregistered' })];
    const items = mergeConversationItems([session()], rooms, {}, 'updated-desc', workspaces);
    expect(items.find((item) => item.key === 'room:example')?.workspace_id).toBe('ws-room');
    expect(items.find((item) => item.key === 'room:unknown')?.workspace_id).toBe('/unregistered');
    expect(rooms[0]!.workspace).toBe('/rooms');
    const unresolved = mergeConversationItems([session()], rooms, {});
    const groups = groupConversationItems(unresolved, { groupBy: 'workspace', workspaces, filters, nowMs: 0 });
    expect(groups.find((group) => group.key === 'ws-room')?.items.map((item) => item.key)).toEqual(['room:example']);
    expect(groups.find((group) => group.key === '__none')?.items.map((item) => item.key)).toEqual(['room:unknown']);
    expect(groupConversationItems(unresolved, { groupBy: 'none', workspaces, filters: { ...filters, workspaces: ['ws-room'] }, nowMs: 0 })[0]?.items.map((item) => item.key)).toEqual(['room:example']);
    expect(groupConversationItems(unresolved, { groupBy: 'time', workspaces, filters: { ...filters, workspaces: ['ws-thread'] }, nowMs: 0 })[0]?.items.map((item) => item.key)).toEqual(['session:example']);
    expect(buildConversationInbox([session()], rooms, {}, workspaces).unread.map((item) => [item.sessionId, item.workspaceId])).toEqual([
      ['room:example', 'ws-room'], ['room:unknown', '/unregistered'], ['example', 'ws-thread'],
    ]);
  });
  it.each([
    ['ws-room', 'ws-room'], ['/rooms/', 'ws-room'], ['/ROOMS', '/ROOMS'], ['/rooms/nested', '/rooms/nested'],
    ['c:/EXAMPLE/project/', 'ws-windows'], ['C:\\example\\project', 'ws-windows'],
    ['\\\\HOST\\Share\\Project', 'ws-unc'], ['ssh://other/project', 'ssh://other/project'],
  ])('resolves only registered room workspace identities: %s', (reference, expected) => {
    expect(roomWorkspaceId(reference, [...workspaces, { id: 'ws-windows', root: 'C:/Example/Project' }, { id: 'ws-unc', root: '//host/share/project' }])).toBe(expected);
  });
  it('interleaves rooms by activity and shares pins, workspace and archive filters', () => {
    const items = mergeConversationItems([session(), session({ id: 'newer', updated_at: new Date(2026, 0, 3, 14).toISOString() })], [room(), room({ id: 'hidden', archived: true }), room({ id: 'pin', pinned: true, updatedAt: '2025-12-01T00:00:00Z' })], {});
    const none = groupConversationItems(items, { groupBy: 'none', workspaces, filters, nowMs: new Date(2026, 0, 3, 23).getTime() });
    expect(none[0]!.items.map((item) => item.key)).toEqual(['room:pin', 'session:newer', 'room:example', 'session:example']);
    const time = groupConversationItems(items, { groupBy: 'time', workspaces, filters, nowMs: new Date(2026, 0, 3, 23).getTime() });
    expect(time.map((group) => [group.key, group.items.map((item) => item.kind)])).toEqual([['pinned', ['room']], ['today', ['session', 'room', 'session']]]);
    const workspace = groupConversationItems(items, { groupBy: 'workspace', workspaces, filters, nowMs: 0 });
    expect(workspace.find((group) => group.key === 'ws-room')!.items.every((item) => item.kind === 'room')).toBe(true);
    expect(workspace.find((group) => group.key === 'ws-thread')!.items.every((item) => item.kind === 'session')).toBe(true);
    expect(groupConversationItems(items, { groupBy: 'none', workspaces, filters: { ...filters, workspaces: ['missing'] }, nowMs: 0 })).toEqual([]);
  });
  it('counts independent high-water marks and keeps blocked rooms after mark-all-read', () => {
    markSessionSeen('example', 10);
    expect(roomUnreadCount('example', 3, sessionSeenSnapshot())).toBe(3);
    markRoomSeen('example', 2);
    markRoomSeen('example', 1);
    expect(roomUnreadCount('example', 3, sessionSeenSnapshot())).toBe(1);
    const rooms = [room({ failed: true }), room({ id: 'budget', needsYou: true }), room({ id: 'question', needsYou: true, pendingInteraction: 'question', busy: true }), room({ id: 'working', busy: true }), room({ id: 'archived', archived: true })];
    const inbox = buildConversationInbox([session()], rooms, sessionSeenSnapshot());
    expect(inbox.unread.map((item) => [item.sessionId, item.reason])).toEqual([['room:example', 'failed']]);
    expect(inbox.needsYou.map((item) => item.reason)).toEqual(['budget', 'question']);
    for (const item of [...inbox.unread, ...inbox.needsYou]) markSessionSeen(item.sessionId, item.lastSeq);
    const read = buildConversationInbox([session()], rooms, sessionSeenSnapshot());
    expect(read.unread).toEqual([]);
    expect(read.needsYou).toHaveLength(2);
    expect(mergeConversationItems([], [room({ lastSeq: 4 })], sessionSeenSnapshot())[0]!.unread_count).toBe(1);
    forgetRoomSeen('example');
    expect(sessionSeenSnapshot()['example']).toBe(10);
    expect(sessionSeenSnapshot()['room:example']).toBeUndefined();
  });
  it('does not fabricate a question when filtering budget-paused rooms', () => {
    const items = mergeConversationItems([], [room({ needsYou: true })], {});
    const groups = groupConversationItems(items, { groupBy: 'none', workspaces, filters: { ...filters, status: ['needs-me'] }, nowMs: 0 });
    expect(groups[0]!.items[0]!.pending_interaction).toBe('none');
    expect(groupConversationItems(items, { groupBy: 'none', workspaces, filters: { ...filters, status: ['running'] }, nowMs: 0 })).toEqual([]);
  });
});

describe('conversation links', () => {
  it('uses the room route and parses the short and protocol forms without losing context', () => {
    expect(roomRefLink('example-room')).toBe('/rooms/example-room');
    expect(parseConversationLink('/rooms/example-room')).toEqual({ kind: 'room', id: 'example-room', href: '/rooms/example-room' });
    expect(parseConversationLink('/r/example-room?workspace=ws#message')).toMatchObject({ href: '/rooms/example-room?workspace=ws#message' });
    expect(parseConversationLink('kiki://r/example-room')).toMatchObject({ kind: 'room', id: 'example-room' });
    expect(parseConversationLink('/s/session_example')).toMatchObject({ kind: 'session', href: '/s/session_example' });
  });
  it.each(['/r/', '/r/../settings', '/r/a/b', '/r/a%2Fb', 'javascript:alert(1)', '//example.test/r/a', 'kiki://user@r/a', 'kiki://r:123/a'])('rejects malformed or foreign routes: %s', (link) => {
    expect(parseConversationLink(link)).toBeUndefined();
  });
});
