import { describe, expect, it } from 'vitest';

import type { WireRecord } from '#/wire/record';
import { sliceMainRecordsAtTurn } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';

function user(id: string, text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    time,
    message: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function assistant(id: string, text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    time,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
  };
}

describe('sliceMainRecordsAtTurn message boundaries', () => {
  const records: WireRecord[] = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'turn.prompt', time: 2, input: [{ type: 'text', text: 'one' }], origin: { kind: 'user' } },
    user('u1', 'one', 3),
    assistant('a1', 'reply one', 4),
    { type: 'turn.prompt', time: 5, input: [{ type: 'text', text: 'two' }], origin: { kind: 'user' } },
    user('u2', 'two', 6),
    assistant('a2', 'reply two', 7),
  ];

  it('retains exactly through a user message for an open-tail fork', () => {
    const slice = sliceMainRecordsAtTurn(records, 'session_test', 1, true);
    expect(slice.records.at(-1)).toMatchObject({
      type: 'context.append_message',
      message: { id: 'u2' },
    });
    expect(slice.records.some((record) => (record['message'] as { id?: string } | undefined)?.id === 'a2')).toBe(false);
    expect(slice.cutoffTime).toBe(6);
  });

  it('keeps the complete addressed turn for an assistant boundary', () => {
    const slice = sliceMainRecordsAtTurn(records, 'session_test', 0);
    expect(slice.records.at(-1)).toMatchObject({
      type: 'context.append_message',
      message: { id: 'a1' },
    });
    expect(slice.records.some((record) => (record['message'] as { id?: string } | undefined)?.id === 'u2')).toBe(false);
  });
});
