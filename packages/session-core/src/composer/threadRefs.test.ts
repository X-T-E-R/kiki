import { describe, expect, it } from 'vitest';

import type { Session } from '@kiki/protocol';

import {
  appendThreadRefContext,
  findThreadRefs,
  insertThreadRef,
  isAppRouteLink,
  removeThreadRef,
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
    title: 'Fix "flaky" <tests>',
    workspaceId: 'wd_1',
    workspaceName: 'kiki',
    cwd: 'C:/src/kiki',
    status: 'running' as const,
    updatedAt: '2026-01-01T12:00:00.000Z',
  };

  it('writes one escaped tag per referenced thread plus the tool hint', () => {
    const sent = appendThreadRefContext(`compare with /s/${ID} and /s/${ID}`, () => info);
    expect(sent).toBe(
      `compare with /s/${ID} and /s/${ID}\n\n<thread_refs>\n` +
        `<thread_ref id="${ID}" title="Fix &quot;flaky&quot; &lt;tests&gt;" workspace="kiki" workspace_id="wd_1" ` +
        'cwd="C:/src/kiki" status="running" updated_at="2026-01-01T12:00:00.000Z"/>\n' +
        'The user linked the Kiki threads above. Read one with ThreadRead (ThreadList returns the host_id it needs) ' +
        'or search it with HistorySearch (scope=session, session_id=<id>).\n</thread_refs>',
    );
    expect(stripThreadRefContext(sent)).toBe(`compare with /s/${ID} and /s/${ID}`);
  });

  it('leaves link-free text alone and never stacks two blocks', () => {
    expect(appendThreadRefContext('plain text', () => info)).toBe('plain text');
    const once = appendThreadRefContext(`/s/${ID}`, () => info);
    expect(appendThreadRefContext(once, () => info)).toBe(once);
  });

  it('omits what is unknown instead of guessing', () => {
    expect(threadRefTag({ sessionId: ID, status: 'unknown' })).toBe(`<thread_ref id="${ID}" status="unknown"/>`);
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

  it('inserts at the caret with spaces only where needed', () => {
    expect(insertThreadRef('hello', { start: 5, end: 5 }, `/s/${ID}`)).toEqual({
      text: `hello /s/${ID} `,
      cursor: `hello /s/${ID} `.length,
    });
    expect(insertThreadRef('ab', { start: 1, end: 1 }, '/s/x')).toEqual({ text: 'a /s/x b', cursor: 7 });
  });
});
