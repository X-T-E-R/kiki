import { describe, expect, it } from 'vitest';

import {
  listThreadsQuerySchema,
  listThreadMessagesResponseSchema,
  readThreadResponseSchema,
  sendThreadMessageRequestSchema,
  threadRefSchema,
  waitThreadsRequestSchema,
} from '../index';

const ref = { host_id: 'host-a', workspace_id: 'workspace-a', session_id: 'session-a' };

describe('peer-thread REST schemas', () => {
  it('retains history preparation, progress and generation on empty pages', () => {
    const page = { items: [], incomplete: 'history_preparing', history: {
      generation: 'example-generation', state: 'preparing', processedMessages: 5, completedShards: 1, totalShards: 16, pending: 'room',
    } };
    expect(listThreadMessagesResponseSchema.parse(page)).toEqual(page);
    expect(listThreadMessagesResponseSchema.safeParse({ ...page, history: { ...page.history, processedMessages: -1 } }).success).toBe(false);
  });
  it('requires all three host-qualified reference fields', () => {
    expect(threadRefSchema.safeParse(ref).success).toBe(true);
    expect(threadRefSchema.safeParse({ workspace_id: 'w', session_id: 's' }).success).toBe(false);
    expect(threadRefSchema.safeParse({ ...ref, host_id: ' ' }).success).toBe(false);
  });

  it('preserves a preparing read page without treating it as empty history', () => {
    const page = { thread: ref, turns: [], incomplete: 'history_preparing', next_cursor: 'opaque-preparation-cursor' };
    expect(readThreadResponseSchema.parse(page)).toEqual(page);
    expect(readThreadResponseSchema.safeParse({ ...page, incomplete: 'scan_budget' }).success).toBe(false);
  });

  it('preserves long-turn content references in the REST response', () => {
    const contentRef = { source: { kind: 'turn', id: '7' }, revision: 'wire-generation-span', path: ['output'], kind: 'text', offset: 0, total: 5000 };
    const page = { thread: ref, turns: [{ turn_id: 7, ended_at: 2, reason: 'completed', origin: 'user', input: 'preview', output: 'preview', content_refs: [contentRef] }] };
    expect(readThreadResponseSchema.parse(page)).toEqual(page);
  });

  it('bounds list and wait inputs', () => {
    expect(listThreadsQuerySchema.parse({ limit: '8' }).limit).toBe(8);
    expect(listThreadsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(waitThreadsRequestSchema.safeParse({ threads: [], timeout_ms: 0 }).success).toBe(false);
    expect(
      waitThreadsRequestSchema.safeParse({
        threads: Array.from({ length: 9 }, (_, index) => ({
          thread: { ...ref, session_id: `s-${index}` },
        })),
      }).success,
    ).toBe(false);
    expect(
      waitThreadsRequestSchema.safeParse({
        threads: [{ thread: ref }, { thread: ref }],
        timeout_ms: 60_001,
      }).success,
    ).toBe(false);
  });

  it('rejects empty and oversized send fields', () => {
    expect(
      sendThreadMessageRequestSchema.safeParse({
        target: { ...ref, session_id: 'session-b' },
        content: '',
        idempotency_key: 'key',
      }).success,
    ).toBe(false);
    expect(
      sendThreadMessageRequestSchema.safeParse({
        target: { ...ref, session_id: 'session-b' },
        content: 'ok',
        idempotency_key: 'x'.repeat(257),
      }).success,
    ).toBe(false);
  });

  it('rejects the legacy source field instead of stripping it', () => {
    expect(
      sendThreadMessageRequestSchema.safeParse({
        source: ref,
        target: { ...ref, session_id: 'session-b' },
        content: 'external message',
        idempotency_key: 'key',
      }).success,
    ).toBe(false);
  });
});
