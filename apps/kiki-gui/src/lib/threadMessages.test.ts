import { describe, expect, it, vi } from 'vitest';

import type { ListThreadMessagesQuery, ListThreadMessagesResponse } from '@kiki/protocol';

import {
  endpointHref,
  groupByPeer,
  messageJumpHref,
  readThreadMessagesPage,
  type ThreadToThreadMessage,
} from './threadMessages';

const ref = (session_id: string) => ({ host_id: 'h', workspace_id: 'ws', session_id });
const endpoint = (session_id: string, patch: { deleted?: boolean; archived?: boolean; title?: string } = {}) => ({
  ref: ref(session_id), title: patch.title ?? session_id, deleted: patch.deleted ?? false, archived: patch.archived ?? false,
});

function message(id: string, from: string, to: string, at: number, patch: Partial<ThreadToThreadMessage> = {}): ThreadToThreadMessage {
  return {
    message_id: id,
    source: { kind: 'thread', thread: endpoint(from) },
    target: endpoint(to),
    content: `hello from ${from}`,
    accepted_at: at,
    target_seq: 99,
    delivery: 'delivered',
    ...patch,
  };
}

describe('readThreadMessagesPage', () => {
  it('follows empty pages that still carry a cursor, repeating the same filters', async () => {
    const pages: ListThreadMessagesResponse[] = [
      { items: [], next_cursor: 'c1', incomplete: 'scan_budget' },
      { items: [], next_cursor: 'c2', incomplete: 'scan_budget' },
      { items: [message('m1', 'a', 'b', 10)], next_cursor: 'c3' },
    ];
    const list = vi.fn(async (_query: ListThreadMessagesQuery) => pages.shift()!);
    const page = await readThreadMessagesPage(list, { session_id: 'a', peer_session_id: 'b' });
    expect(page.items.map((item) => item.message_id)).toEqual(['m1']);
    expect(page.nextCursor).toBe('c3');
    expect(list.mock.calls.map(([query]) => query)).toEqual([
      { session_id: 'a', peer_session_id: 'b', cursor: undefined },
      { session_id: 'a', peer_session_id: 'b', cursor: 'c1' },
      { session_id: 'a', peer_session_id: 'b', cursor: 'c2' },
    ]);
  });

  it('stops at the end of the chain and skips reserved room messages', async () => {
    const room = { ...message('r1', 'a', 'b', 5), source: { kind: 'room' as const, room_id: 'room-1' } };
    const list = vi.fn(async () => ({ items: [room], next_cursor: undefined }));
    const page = await readThreadMessagesPage(list, {});
    expect(page).toEqual({ items: [], nextCursor: undefined, incomplete: false });
  });

  it('hands a cursor back after a bounded run of empty pages', async () => {
    const list = vi.fn(async () => ({ items: [], next_cursor: 'again', incomplete: 'scan_budget' as const }));
    const page = await readThreadMessagesPage(list, {});
    expect(page.nextCursor).toBe('again');
    expect(page.incomplete).toBe(true);
    expect(list).toHaveBeenCalledTimes(8);
  });
});

describe('groupByPeer', () => {
  it('groups both directions under the other thread, most recent peer first', () => {
    const groups = groupByPeer([
      message('m3', 'self', 'b', 30),
      message('m2', 'c', 'self', 20, { delivery: 'undeliverable', reason: 'thread closed' }),
      message('m1', 'b', 'self', 10),
    ], 'self');
    expect(groups.map((group) => group.peer.ref.session_id)).toEqual(['b', 'c']);
    expect(groups[0]).toMatchObject({ sent: 1, received: 1, latestDirection: 'out', undeliverable: 0 });
    expect(groups[1]).toMatchObject({ sent: 0, received: 1, latestDirection: 'in', undeliverable: 1 });
  });
});

describe('navigation', () => {
  it('lands on the recipient prompt by message id, never by target_seq', () => {
    expect(messageJumpHref(message('msg_1', 'a', 'b', 1))).toBe('/s/b?block=user-msg_1');
  });

  it('gives no link for a deleted recipient or an undelivered message', () => {
    expect(messageJumpHref(message('m', 'a', 'b', 1, { target: endpoint('b', { deleted: true }) }))).toBeUndefined();
    expect(messageJumpHref(message('m', 'a', 'b', 1, { delivery: 'pending' }))).toBeUndefined();
    expect(messageJumpHref(message('m', 'a', 'b', 1, { delivery: 'undeliverable' }))).toBeUndefined();
    expect(endpointHref(endpoint('x', { deleted: true }))).toBeUndefined();
    expect(endpointHref(endpoint('x', { archived: true }))).toBe('/s/x');
  });
});
