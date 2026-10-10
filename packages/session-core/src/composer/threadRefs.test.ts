import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';
import { projectPresentedText } from '@kiki/transcript';

import {
  appendThreadRefContext,
  findConversationRefs,
  findThreadRefs,
  prepareThreadRefContext,
  insertThreadRef,
  isAppRouteLink,
  removeThreadRef,
  roomRefTag,
  stripThreadRefContext,
  threadRefDeletionRange,
  threadRefInfoOf,
  threadRefTag,
} from './threadRefs';

const ID = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('findThreadRefs', () => {
  it('finds the in-app route the sidebar copies, with its bounds', () => {
    const text = `see /s/${ID} please`;
    expect(findThreadRefs(text)).toEqual([
      { start: 4, end: 4 + `/s/${ID}`.length, raw: `/s/${ID}`, sessionId: ID },
    ]);
  });

  it('accepts full GUI URLs, kiki:// links and sub-routes', () => {
    const text = [
      `http://127.0.0.1:5177/s/${ID}?server=x`,
      `https://tauri.localhost/s/${ID}/agent/a1`,
      `kiki://s/${ID}`,
      `kiki://session/${ID}`,
    ].join(' ');
    const refs = findThreadRefs(text);
    expect(refs.map((ref) => ref.sessionId)).toEqual([ID, ID, ID, ID]);
    expect(refs[0]?.raw).toBe(`http://127.0.0.1:5177/s/${ID}?server=x`);
  });

  it('stops at trailing punctuation and ignores non-session routes', () => {
    expect(findThreadRefs(`(/s/${ID}).`)[0]?.raw).toBe(`/s/${ID}`);
    expect(findThreadRefs(`对比 /s/${ID}，再看`)[0]?.raw).toBe(`/s/${ID}`);
    expect(findThreadRefs('/settings/models /s/ /s/not-a-session a/s/session_x')).toEqual([]);
  });
});

describe('findConversationRefs', () => {
  it.each([
    ['/rooms/example-room', ''],
    ['/r/example-room', ''],
    ['kiki://r/example-room', ''],
    ['kiki://rooms/example-room', ''],
    ['http://localhost:5173/rooms/example-room', ''],
    ['tauri://localhost/r/example-room', ''],
    ['/rooms/example-room?workspace=ws#message', '?workspace=ws#message'],
    ['/r/example-room/log#message', '/log#message'],
  ])('finds a room link and canonicalises its route: %s', (raw, tail) => {
    expect(findConversationRefs(raw)).toEqual([
      { start: 0, end: raw.length, raw, kind: 'room', id: 'example-room', href: `/rooms/example-room${tail}` },
    ]);
  });

  it('preserves query, hash, and sub-route tails in session hrefs', () => {
    const text = `/s/${ID}?turn=2#message /s/${ID}/agent/a1`;
    expect(findConversationRefs(text).map((ref) => ({ raw: ref.raw, href: ref.href }))).toEqual([
      { raw: `/s/${ID}?turn=2#message`, href: `/s/${ID}?turn=2#message` },
      { raw: `/s/${ID}/agent/a1`, href: `/s/${ID}/agent/a1` },
    ]);
  });

  it('finds mixed references once in document order and keeps thread-only bounds', () => {
    const thread = `/s/${ID}`;
    const room = '/rooms/example-room';
    const text = `看（${thread}），再看「${room}」。`;
    const refs = findConversationRefs(text);
    expect(refs).toEqual([
      { start: 2, end: 2 + thread.length, raw: thread, kind: 'session', id: ID, href: thread },
      { start: text.indexOf(room), end: text.indexOf(room) + room.length, raw: room, kind: 'room', id: 'example-room', href: room },
    ]);
    expect(refs.map((ref) => text.slice(ref.start, ref.end))).toEqual([thread, room]);
    expect(findThreadRefs(text)).toEqual([{ start: 2, end: 2 + thread.length, raw: thread, sessionId: ID }]);
    expect(findThreadRefs(room)).toEqual([]);
    expect(findConversationRefs(`"${room}" [${room}], '${room}'`).map((ref) => ref.raw)).toEqual([room, room, room]);
  });

  it('accepts opaque room ids within the existing charset and length limit', () => {
    expect(findConversationRefs('/rooms/r1 /rooms/room_2026').map((ref) => ref.id)).toEqual(['r1', 'room_2026']);
    expect(findConversationRefs(`/rooms/${'a'.repeat(128)}`)).toHaveLength(1);
    expect(findConversationRefs(`/rooms/${'a'.repeat(129)}`)).toEqual([]);
    expect(findConversationRefs('/s/not-a-session /rooms/session_abc /rooms/_room /rooms/a%2Fb')).toEqual([]);
  });

  it('rejects foreign origins without matching their bare route tails', () => {
    expect(findConversationRefs('https://example.com/rooms/foo')).toEqual([]);
    expect(findConversationRefs('https://kiki.example.com/rooms/example-room')).toEqual([]);
    expect(findConversationRefs('https://example.com/rooms/foo', { origin: 'https://kiki.example.com' })).toEqual([]);
    expect(findThreadRefs(`https://example.com/s/${ID}`)).toEqual([]);
    expect(findConversationRefs('ftp://localhost/rooms/foo kiki://other/rooms/foo')).toEqual([]);
  });

  it('matches loopback hosts and the caller origin with case-insensitive host and exact port', () => {
    expect(findConversationRefs('http://127.0.0.1:8080/s/session_example')[0]?.kind).toBe('session');
    expect(findConversationRefs('http://[::1]:5173/rooms/r1')[0]?.kind).toBe('room');
    expect(findConversationRefs('http://0.0.0.0:5173/rooms/r1')[0]?.kind).toBe('room');
    const raw = 'https://kiki.example.com:8443/rooms/example-room';
    expect(findConversationRefs(raw, { origin: 'https://KIKI.EXAMPLE.COM:8443' })[0]?.raw).toBe(raw);
    expect(findConversationRefs(raw, { origin: 'kiki.example.com:8443' })[0]?.raw).toBe(raw);
    expect(findConversationRefs(raw, { origin: 'https://kiki.example.com' })).toEqual([]);
    expect(findConversationRefs(raw, { origin: 'not an origin' })).toEqual([]);
    expect(findConversationRefs('http://localhost:5173/rooms/r1', { origin: 'localhost:5173' })[0]?.id).toBe('r1');
    expect(findConversationRefs('/r/r1 kiki://rooms/r1', { origin: 'not an origin' }).map((ref) => ref.id)).toEqual(['r1', 'r1']);
    expect(findThreadRefs(`https://kiki.example.com/s/${ID}`, { origin: 'https://kiki.example.com' })[0]?.sessionId).toBe(ID);
  });
});

describe('isAppRouteLink', () => {
  it('names GUI routes, never a command token', () => {
    expect(isAppRouteLink(`/s/${ID}`)).toBe(true);
    expect(isAppRouteLink('/settings/models')).toBe(true);
    expect(isAppRouteLink('/review')).toBe(false);
    expect(isAppRouteLink('/s')).toBe(false);
  });
});

describe('thread context block', () => {
  const info = {
    sessionId: ID,
    hostId: 'host-example',
    title: 'Fix "flaky" <tests>',
    workspaceId: 'wd_1',
    workspaceName: 'kiki',
    cwd: 'C:/src/kiki',
    status: 'running' as const,
    updatedAt: '2026-01-01T12:00:00.000Z',
  };

  it('writes one escaped tag per referenced thread plus the tool hint', () => {
    const body = `compare with /s/${ID} and /s/${ID}`;
    const sent = appendThreadRefContext(body, () => info);
    expect(sent).toBe(
      `${body}\n\n<thread_refs>\n` +
        `<thread_ref id="${ID}" host_id="host-example" title="Fix &quot;flaky&quot; &lt;tests&gt;" workspace="kiki" workspace_id="wd_1" ` +
        'cwd="C:/src/kiki" status="running" updated_at="2026-01-01T12:00:00.000Z"/>\n' +
        'The user linked the Kiki threads above. Read one with ThreadRead using its host_id, workspace_id and id as session_id ' +
        '(omit host_id for this host if absent), or search it with HistorySearch (scope=session, session_id=<id>).' +
        ' A <room_ref> is a Kiki room the user linked; its page and log live at that room id, and speaking there uses ThreadSend({room: "<id>", content, mentions?}).\n</thread_refs>',
    );
    expect(stripThreadRefContext(sent)).toBe(sent);
    const prepared = prepareThreadRefContext(body, () => info);
    expect(prepared).toEqual({
      text: sent,
      presentation: { spans: [{ start: body.length, end: sent.length, kind: 'context' }] },
    });
    expect(projectPresentedText(prepared.text, prepared.presentation)).toBe(body);
  });

  it('leaves link-free text alone and keeps user-authored markup literal', () => {
    expect(appendThreadRefContext('plain text', () => info)).toBe('plain text');
    const authored = `/s/${ID}\n\n<thread_refs>\nuser-authored note\n</thread_refs>\n\n> a literal blockquote`;
    expect(stripThreadRefContext(authored)).toBe(authored);
    expect(projectPresentedText(authored)).toBe(authored);
  });

  it('omits what is unknown instead of guessing', () => {
    expect(threadRefTag({ sessionId: ID, status: 'unknown' })).toBe(`<thread_ref id="${ID}" status="unknown"/>`);
  });

  it('adds each linked room once in the same block and marks generated context explicitly', () => {
    const text = `/rooms/example-room /s/${ID} /r/example-room /s/${ID}`;
    const resolveRoom = (id: string) => ({ id, name: ' Planning "A&B" <room> ', workspaceId: 'ws-example', memberCount: 2 });
    const once = appendThreadRefContext(text, () => info, resolveRoom);
    expect(once.split('\n').filter((line) => line.startsWith('<room_ref ') || line.startsWith('<thread_ref '))).toEqual([
      '<room_ref id="example-room" name="Planning &quot;A&amp;B&quot; &lt;room&gt;" workspace_id="ws-example" member_count="2"/>',
      threadRefTag(info),
    ]);
    expect(stripThreadRefContext(once)).toBe(once);
    const prepared = prepareThreadRefContext(text, () => info, resolveRoom);
    expect(prepared.presentation).toEqual({ spans: [{ start: text.length, end: once.length, kind: 'context' }] });
    expect(projectPresentedText(prepared.text, prepared.presentation)).toBe(text);
    expect(roomRefTag({ id: 'r1' })).toBe('<room_ref id="r1"/>');
    expect(roomRefTag({ id: 'r1', name: ' ', workspaceId: '', memberCount: 0 })).toBe('<room_ref id="r1" member_count="0"/>');
  });

  it('skips room context without a room resolver and keeps thread context', () => {
    const text = '/rooms/example-room';
    expect(() => appendThreadRefContext(text, () => info)).not.toThrow();
    expect(appendThreadRefContext(text, () => info)).toBe(text);
    const mixed = appendThreadRefContext(`${text} /s/${ID}`, () => info);
    expect(mixed).toContain(threadRefTag(info));
    expect(mixed).not.toContain('<room_ref id=');
  });

  it('shares caller-origin options between finding, context and whole-link editing', () => {
    const options = { origin: 'https://kiki.example.com' };
    const text = 'https://kiki.example.com/rooms/example-room';
    expect(findConversationRefs(text, options)[0]?.raw).toBe(text);
    expect(appendThreadRefContext(text, () => info, (id) => ({ id }), options)).toContain('<room_ref id="example-room"/>');
    expect(threadRefDeletionRange(text, text.length, text.length, 'Backspace', options)).toEqual({ start: 0, end: text.length });
    expect(appendThreadRefContext(text, () => info, (id) => ({ id }))).toBe(text);
    expect(threadRefDeletionRange(text, text.length, text.length, 'Backspace')).toBeNull();
  });

  it('preserves and escapes the host ID, including for unloaded threads', () => {
    const resolved = threadRefInfoOf(ID, undefined, undefined, 'host-"example&');
    expect(resolved.hostId).toBe('host-"example&');
    expect(threadRefTag(resolved)).toBe(`<thread_ref id="${ID}" host_id="host-&quot;example&amp;" status="unknown"/>`);
  });

  it('derives status from the record, pending interaction first', () => {
    const record = {
      id: ID, workspace_id: 'wd_1', title: '', updated_at: '2026-01-01T00:00:00.000Z',
      busy: true, pending_interaction: 'question', metadata: { cwd: 'C:/x' },
    } as unknown as Session;
    expect(threadRefInfoOf(ID, record, undefined)).toMatchObject({ status: 'awaiting_answer', title: undefined, cwd: 'C:/x' });
    expect(threadRefInfoOf(ID, undefined, undefined)).toEqual({ sessionId: ID, status: 'unknown' });
  });
});

describe('composer editing', () => {
  const text = `a /s/${ID} b`;
  const start = 2;
  const end = start + `/s/${ID}`.length;

  it('widens Backspace after, Delete before, and overlapping selections to the whole link', () => {
    expect(threadRefDeletionRange(text, end, end, 'Backspace')).toEqual({ start, end });
    expect(threadRefDeletionRange(text, start, start, 'Delete')).toEqual({ start, end });
    expect(threadRefDeletionRange(text, 0, start + 3, 'Backspace')).toEqual({ start: 0, end });
    expect(threadRefDeletionRange(text, start, start, 'Backspace')).toBeNull();
    expect(threadRefDeletionRange(text, 1, 1, 'Backspace')).toBeNull();
  });

  it('removes a link with one separating space', () => {
    expect(removeThreadRef(text, { start, end })).toEqual({ text: 'a b', cursor: 2 });
  });

  it('widens deletion around or inside a room link and removes one separating space', () => {
    const link = '/rooms/example-room?workspace=ws#message';
    const draft = `a ${link} b`;
    const ref = findConversationRefs(draft)[0]!;
    expect(threadRefDeletionRange(draft, ref.end, ref.end, 'Backspace')).toEqual({ start: ref.start, end: ref.end });
    expect(threadRefDeletionRange(draft, ref.start, ref.start, 'Delete')).toEqual({ start: ref.start, end: ref.end });
    expect(threadRefDeletionRange(draft, ref.start + 3, ref.start + 3, 'Backspace')).toEqual({ start: ref.start, end: ref.end });
    expect(threadRefDeletionRange(draft, ref.start + 3, ref.start + 3, 'Delete')).toEqual({ start: ref.start, end: ref.end });
    expect(threadRefDeletionRange(draft, 0, ref.start + 3, 'Backspace')).toEqual({ start: 0, end: ref.end });
    expect(threadRefDeletionRange(draft, ref.start, ref.start, 'Backspace')).toBeNull();
    expect(removeThreadRef(draft, ref)).toEqual({ text: 'a b', cursor: 2 });
  });

  it('inserts at the caret with spaces only where needed', () => {
    expect(insertThreadRef('hello', { start: 5, end: 5 }, `/s/${ID}`)).toEqual({
      text: `hello /s/${ID} `,
      cursor: `hello /s/${ID} `.length,
    });
    expect(insertThreadRef('ab', { start: 1, end: 1 }, '/s/x')).toEqual({ text: 'a /s/x b', cursor: 7 });
  });
});
