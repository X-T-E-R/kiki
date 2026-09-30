import { describe, expect, it } from 'vitest';
import { botSummarySchema, botUpdateInputSchema, createRoomInputSchema, updateRoomInputSchema, postRoomMessageInputSchema, roomLogResultSchema, roomMemberSchema, createThreadRoomInputSchema, searchRoomThreadsInputSchema, sessionCreateSchema, sessionUpdateSchema } from '../index';

describe('Bot and room protocol', () => {
  it('exposes persistent home identity without requiring a home session for every card', () => {
    expect(botSummarySchema.parse({ personaId: 'example-bot', name: 'Example', pinned: false, hidden: false }).homeSessionId).toBeUndefined();
    expect(botUpdateInputSchema.parse({ pinned: true })).toEqual({ pinned: true });
  });
  it('validates room membership and accepts independent budget and mute edits', () => {
    const members = [{ personaId: 'example-a' }, { personaId: 'example-b' }];
    expect(createRoomInputSchema.parse({ name: 'Room', members, workspace: '/example' }).members).toHaveLength(2);
    expect(createRoomInputSchema.safeParse({ name: 'Room', members: members.slice(0, 1), workspace: '/example' }).success).toBe(false);
    expect(updateRoomInputSchema.parse({ budget: { botMessagesPerUserMessage: 12 } }).budget?.botMessagesPerUserMessage).toBe(12);
    expect(updateRoomInputSchema.parse({ members: members.map((m) => ({ ...m, muted: true })) }).members?.[0]?.muted).toBe(true);
  });
  it('accepts mixed and thread-only inputs while keeping discriminated members and bounded search', () => {
    const thread = { kind: 'thread', sessionId: 'session-example', queueWhenBusy: false };
    expect(createRoomInputSchema.parse({ name: 'Mixed', workspace: '/classification', members: [{ personaId: 'example-a' }, thread], host: thread.sessionId }).host).toBe(thread.sessionId);
    expect(createThreadRoomInputSchema.parse({ name: 'Threads', workspace: '/classification', sessionIds: ['session-a', 'session-b'] }).sessionIds).toHaveLength(2);
    expect(createThreadRoomInputSchema.safeParse({ name: 'Too small', workspace: '/classification', sessionIds: ['session-a'] }).success).toBe(false);
    expect(roomMemberSchema.parse({ kind: 'thread', sessionId: 'session-a', muted: false, joinedAt: '2026-01-01T00:00:00Z', queueWhenBusy: true }).kind).toBe('thread');
    expect(roomMemberSchema.safeParse({ kind: 'thread', personaId: 'example-a', muted: false }).success).toBe(false);
    expect(updateRoomInputSchema.parse({ members: [] }).members).toEqual([]);
    expect(searchRoomThreadsInputSchema.parse({ query: 'example', limit: '5' }).limit).toBe(5);
    expect(searchRoomThreadsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it('preserves incremental log cursors and rejects blank user interruptions', () => {
    expect(roomLogResultSchema.parse({ entries: [], nextCursor: 'row-1' }).nextCursor).toBe('row-1');
    expect(postRoomMessageInputSchema.safeParse({ text: '  ' }).success).toBe(false);
  });
  it('accepts delivery on session creation and update without conflating profile selection', () => {
    expect(sessionCreateSchema.parse({ persona: 'example-bot', delivery: 'message' }).delivery).toBe('message');
    expect(sessionUpdateSchema.parse({ delivery: 'reply' }).delivery).toBe('reply');
    expect(sessionUpdateSchema.safeParse({ delivery: 'silent' }).success).toBe(false);
  });
});
