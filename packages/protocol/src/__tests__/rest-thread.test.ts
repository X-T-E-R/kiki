import { describe, expect, it } from 'vitest';

import {
  listThreadMessagesResponseSchema,
  listThreadsQuerySchema,
  readThreadResponseSchema,
  sendThreadMessageRequestSchema,
  threadRefSchema,
  waitThreadsRequestSchema,
} from '../index';

const ref = { host_id: 'host-a', workspace_id: 'workspace-a', session_id: 'session-a' };

describe('peer-thread REST schemas', () => {
  it('retains history preparation progress on empty message and read pages', () => {
    const msgPage = {
      items: [],
      incomplete: 'history_preparing',
      history: {
        generation: 'example-generation',
        state: 'preparing',
        processedMessages: 5,
        completedShards: 1,
        totalShards: 16,
        pending: 'room',
      },
    };
    expect(listThreadMessagesResponseSchema.parse(msgPage)).toEqual(msgPage);
    expect(
      listThreadMessagesResponseSchema.safeParse({ ...msgPage, history: { ...msgPage.history, processedMessages: -1 } }).success,
    ).toBe(false);

    const readPage = { thread: ref, turns: [], incomplete: 'history_preparing', next_cursor: 'opaque-preparation-cursor' };
    expect(readThreadResponseSchema.parse(readPage)).toEqual(readPage);
    expect(readThreadResponseSchema.safeParse({ ...readPage, incomplete: 'scan_budget' }).success).toBe(false);
  });

  it('preserves long-turn content references in the REST response', () => {
    const contentRef = {
      source: { kind: 'turn', id: '7' },
      revision: 'wire-generation-span',
      path: ['output'],
      kind: 'text',
      offset: 0,
      total: 5000,
    };
    const page = {
      thread: ref,
      turns: [{ turn_id: 7, ended_at: 2, reason: 'completed', origin: 'user', input: 'preview', output: 'preview', content_refs: [contentRef] }],
      view: { segment: { ref: contentRef, value: 'segment', next: { ...contentRef, offset: 7 }, contentRefs: [] } },
    };
    expect(readThreadResponseSchema.parse(page)).toEqual(page);
  });

  it('requires host-qualified thread references and bounds list/wait inputs', () => {
    expect(threadRefSchema.safeParse(ref).success).toBe(true);
    expect(threadRefSchema.safeParse({ workspace_id: 'w', session_id: 's' }).success).toBe(false);
    expect(threadRefSchema.safeParse({ ...ref, host_id: ' ' }).success).toBe(false);

    expect(listThreadsQuerySchema.parse({ limit: '8' }).limit).toBe(8);
    expect(listThreadsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(waitThreadsRequestSchema.safeParse({ threads: [], timeout_ms: 0 }).success).toBe(false);
    expect(
      waitThreadsRequestSchema.safeParse({
        threads: Array.from({ length: 9 }, (_, index) => ({ thread: { ...ref, session_id: `s-${index}` } })),
      }).success,
    ).toBe(false);
    expect(waitThreadsRequestSchema.safeParse({ threads: [{ thread: ref }, { thread: ref }], timeout_ms: 60_001 }).success).toBe(false);
  });

  it.each([
    ['empty content', { target: { ...ref, session_id: 'session-b' }, content: '', idempotency_key: 'key' }],
    ['oversized idempotency_key', { target: { ...ref, session_id: 'session-b' }, content: 'ok', idempotency_key: 'x'.repeat(257) }],
    ['legacy source field', { source: ref, target: { ...ref, session_id: 'session-b' }, content: 'external message', idempotency_key: 'key' }],
  ] as const)('rejects invalid sendThreadMessageRequest (%s)', (_label, payload) => {
    expect(sendThreadMessageRequestSchema.safeParse(payload).success).toBe(false);
  });
});
