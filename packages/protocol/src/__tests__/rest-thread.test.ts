import { describe, expect, it } from 'vitest';

import {
  listThreadsQuerySchema,
  sendThreadMessageRequestSchema,
  threadRefSchema,
  waitThreadsRequestSchema,
} from '../index';

const ref = { host_id: 'host-a', workspace_id: 'workspace-a', session_id: 'session-a' };

describe('peer-thread REST schemas', () => {
  it('requires all three host-qualified reference fields', () => {
    expect(threadRefSchema.safeParse(ref).success).toBe(true);
    expect(threadRefSchema.safeParse({ workspace_id: 'w', session_id: 's' }).success).toBe(false);
    expect(threadRefSchema.safeParse({ ...ref, host_id: ' ' }).success).toBe(false);
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
